import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Calendar,
  CheckCircle2,
  List,
  Lock,
  Unlock,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Project, SwimLane, Team, User } from "../lib/types";
import {
  isSchedulable,
  scheduleRoadmap,
  toPatchBody,
  type ItemProposal,
  type SchedulerResult,
} from "../lib/scheduler";
import { GanttTimeline } from "./GanttTimeline";

/**
 * "Auto-schedule…" modal on the Roadmap view.
 *
 * Two phases:
 *   1. PICK — filter the eligible set of items down by owner and/or
 *      team, then check the exact rows you want to include and mark
 *      any you want locked in place. "Generate proposal" runs the
 *      scheduler synchronously in the browser.
 *   2. REVIEW — one row per proposed item showing old vs new dates,
 *      residual warnings (deadline misses, dependency conflicts,
 *      capacity overloads), and Accept / Back buttons. Accept walks
 *      the changed rows one by one, PATCHing each project's phase
 *      dates and reporting any failures inline.
 *
 * The algorithm is pure and lives in lib/scheduler.ts — this file
 * is just the UI shell + apply plumbing.
 */

type Phase = "pick" | "review" | "applying" | "done";

export function RoadmapHelper({
  projects,
  lanes,
  users,
  teams,
  onClose,
}: {
  projects: Project[];
  lanes: SwimLane[];
  users: User[];
  teams: Team[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const lanesById = useMemo(() => new Map(lanes.map((l) => [l.id, l] as const)), [lanes]);
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t] as const)), [teams]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u] as const)), [users]);

  // Universe = every eligible root project (subtasks aren't part of
  // roadmap capacity counting or the roadmap view itself). We keep
  // them out of the picker so users don't get confused.
  const eligible = useMemo(
    () => projects.filter((p) => !p.parent_id && isSchedulable(p, lanesById)),
    [projects, lanesById],
  );

  const [phase, setPhase] = useState<Phase>("pick");

  // Filter selections — empty = "no filter" (matches the FilterBar
  // convention elsewhere in the app).
  const [teamFilter, setTeamFilter] = useState<Set<string>>(new Set());
  const [ownerFilter, setOwnerFilter] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    return eligible.filter((p) => {
      if (teamFilter.size && !p.teams.some((t) => teamFilter.has(t))) return false;
      if (ownerFilter.size && (!p.owner_id || !ownerFilter.has(p.owner_id))) return false;
      return true;
    });
  }, [eligible, teamFilter, ownerFilter]);

  // Per-row: checked (in the batch) + locked. Track by id so lock
  // state survives filter changes.
  const [checked, setChecked] = useState<Map<string, boolean>>(() => new Map());
  const [locked, setLocked] = useState<Map<string, boolean>>(() => new Map());

  // Auto-check any filtered rows we haven't seen yet (default all
  // ON, default all UNLOCKED). We do this lazily so users' explicit
  // uncheck doesn't get re-checked when they tweak filters.
  const nextChecked = new Map(checked);
  let changed = false;
  for (const p of filtered) {
    if (!nextChecked.has(p.id)) {
      nextChecked.set(p.id, true);
      changed = true;
    }
  }
  if (changed) {
    // Deferred state update — safe because setState in render is
    // React's official pattern for "derive but persist".
    setChecked(nextChecked);
  }

  const [result, setResult] = useState<SchedulerResult | null>(null);

  const runScheduler = () => {
    const items = filtered
      .filter((p) => checked.get(p.id) !== false)
      .map((p) => ({ project: p, locked: locked.get(p.id) === true }));
    const res = scheduleRoadmap({
      items,
      allProjects: projects,
      lanes,
      users,
      teams,
      today: new Date(),
    });
    setResult(res);
    setPhase("review");
  };

  // Apply flow state
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [applyErrors, setApplyErrors] = useState<Array<{ title: string; message: string }>>([]);

  const runApply = async () => {
    if (!result) return;
    const changes = result.proposals.filter((p) => p.changed);
    setApplyProgress({ done: 0, total: changes.length });
    setApplyErrors([]);
    setPhase("applying");
    const errs: typeof applyErrors = [];
    for (let i = 0; i < changes.length; i++) {
      const prop = changes[i]!;
      try {
        await api<Project>(`/projects/${prop.projectId}`, {
          method: "PATCH",
          body: JSON.stringify(toPatchBody(prop.proposedDates)),
        });
      } catch (e) {
        errs.push({ title: prop.title, message: (e as Error).message ?? "Failed" });
      }
      setApplyProgress({ done: i + 1, total: changes.length });
    }
    setApplyErrors(errs);
    // Refresh caches so the roadmap re-renders with new dates.
    qc.invalidateQueries({ queryKey: ["projects"] });
    setPhase("done");
  };

  const selectedCount = filtered.filter((p) => checked.get(p.id) !== false).length;
  const lockedCount = filtered.filter((p) => locked.get(p.id) === true).length;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white shadow-xl"
          onEscapeKeyDown={(e) => { if (phase === "applying") e.preventDefault(); }}
          onInteractOutside={(e) => { if (phase === "applying") e.preventDefault(); }}
        >
          <div className="flex items-center justify-between border-b border-wp-stone px-5 py-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
              <Wand2 size={18} className="text-wp-red" />
              Auto-schedule roadmap
              <span className="text-xs font-normal text-wp-slate">
                {phase === "pick" && "· Pick items"}
                {phase === "review" && "· Review proposal"}
                {phase === "applying" && "· Applying…"}
                {phase === "done" && "· Done"}
              </span>
            </Dialog.Title>
            <button
              aria-label="Close"
              className="btn-ghost !p-1"
              onClick={onClose}
              disabled={phase === "applying"}
            >
              <X size={18} />
            </button>
          </div>

          {phase === "pick" && (
            <PickPhase
              filtered={filtered}
              eligible={eligible}
              lanesById={lanesById}
              usersById={usersById}
              teamsById={teamsById}
              users={users}
              teams={teams}
              teamFilter={teamFilter}
              ownerFilter={ownerFilter}
              setTeamFilter={setTeamFilter}
              setOwnerFilter={setOwnerFilter}
              checked={checked}
              setChecked={setChecked}
              locked={locked}
              setLocked={setLocked}
              selectedCount={selectedCount}
              lockedCount={lockedCount}
              onCancel={onClose}
              onRun={runScheduler}
            />
          )}

          {phase === "review" && result && (
            <ReviewPhase
              result={result}
              allProjects={projects}
              lanes={lanes}
              teams={teams}
              users={users}
              onBack={() => setPhase("pick")}
              onAccept={runApply}
            />
          )}

          {phase === "applying" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-sm text-wp-slate">
              <div className="text-lg font-medium text-wp-ink">Applying schedule…</div>
              <div className="h-2 w-64 overflow-hidden rounded-full bg-wp-stone">
                <div
                  className="h-full bg-wp-red transition-all"
                  style={{
                    width:
                      applyProgress.total === 0
                        ? "0%"
                        : `${Math.round((applyProgress.done / applyProgress.total) * 100)}%`,
                  }}
                />
              </div>
              <div>
                {applyProgress.done} / {applyProgress.total} items updated
              </div>
            </div>
          )}

          {phase === "done" && (
            <DonePhase errors={applyErrors} total={applyProgress.total} onClose={onClose} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* --- Pick phase --- */

function PickPhase(props: {
  filtered: Project[];
  eligible: Project[];
  lanesById: Map<string, SwimLane>;
  usersById: Map<string, User>;
  teamsById: Map<string, Team>;
  users: User[];
  teams: Team[];
  teamFilter: Set<string>;
  ownerFilter: Set<string>;
  setTeamFilter: (v: Set<string>) => void;
  setOwnerFilter: (v: Set<string>) => void;
  checked: Map<string, boolean>;
  setChecked: (v: Map<string, boolean>) => void;
  locked: Map<string, boolean>;
  setLocked: (v: Map<string, boolean>) => void;
  selectedCount: number;
  lockedCount: number;
  onCancel: () => void;
  onRun: () => void;
}) {
  const {
    filtered, eligible, lanesById, usersById, teamsById, users, teams,
    teamFilter, ownerFilter, setTeamFilter, setOwnerFilter,
    checked, setChecked, locked, setLocked,
    selectedCount, lockedCount, onCancel, onRun,
  } = props;

  const toggleTeam = (id: string) => {
    const next = new Set(teamFilter);
    if (next.has(id)) next.delete(id); else next.add(id);
    setTeamFilter(next);
  };
  const toggleOwner = (id: string) => {
    const next = new Set(ownerFilter);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOwnerFilter(next);
  };

  const checkAll = () => {
    const next = new Map(checked);
    for (const p of filtered) next.set(p.id, true);
    setChecked(next);
  };
  const uncheckAll = () => {
    const next = new Map(checked);
    for (const p of filtered) next.set(p.id, false);
    setChecked(next);
  };

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-sm text-wp-slate">
          Pick the items to include and mark any you want locked (dates won't change). The
          algorithm respects priority order (swim lane, then position), owner and team
          capacity, dependencies, and hard deadlines. Unlocked items may shift forward or
          backward as a unit, but no phase duration or gap will change.
        </p>

        {/* Filters */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FilterChips
            label="Teams"
            options={teams.map((t) => ({ id: t.id, label: t.name, color: t.color }))}
            selected={teamFilter}
            onToggle={toggleTeam}
            onClear={() => setTeamFilter(new Set())}
          />
          <FilterChips
            label="Owners"
            options={users.map((u) => ({ id: u.id, label: u.name, color: u.color }))}
            selected={ownerFilter}
            onToggle={toggleOwner}
            onClear={() => setOwnerFilter(new Set())}
          />
        </div>

        {/* Bulk actions */}
        <div className="flex items-center justify-between text-xs text-wp-slate">
          <div>
            {selectedCount} of {filtered.length} selected
            {lockedCount ? ` · ${lockedCount} locked` : ""}
            {eligible.length !== filtered.length ? ` · ${eligible.length - filtered.length} filtered out` : ""}
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost !py-0.5 !text-xs" onClick={checkAll}>Select all</button>
            <span className="text-wp-stone">·</span>
            <button className="btn-ghost !py-0.5 !text-xs" onClick={uncheckAll}>Clear</button>
          </div>
        </div>

        {/* Item list */}
        {filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-wp-stone p-6 text-center text-sm text-wp-slate">
            {eligible.length === 0
              ? "No scheduled items in this workspace yet — add start/target/dev/opt dates first."
              : "No items match the current filter."}
          </div>
        ) : (
          <ul className="divide-y divide-wp-stone rounded-md border border-wp-stone">
            {filtered.map((p) => {
              const lane = p.swim_lane_id ? lanesById.get(p.swim_lane_id) : null;
              const owner = p.owner_id ? usersById.get(p.owner_id) : null;
              const teamNames = p.teams
                .map((tid) => teamsById.get(tid)?.name)
                .filter(Boolean)
                .join(", ");
              const isChecked = checked.get(p.id) !== false;
              const isLocked = locked.get(p.id) === true;
              return (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                      const next = new Map(checked);
                      next.set(p.id, e.target.checked);
                      setChecked(next);
                    }}
                    className="h-4 w-4 accent-wp-red"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-wp-ink">{p.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-wp-slate">
                      {lane ? <span>{lane.name}</span> : null}
                      {owner ? <span>· {owner.name}</span> : null}
                      {teamNames ? <span>· {teamNames}</span> : null}
                      <span className="ml-1 inline-flex items-center gap-1 text-wp-slate/80">
                        <Calendar size={11} />
                        {p.start_date} → {p.optimization_end_date}
                      </span>
                    </div>
                  </div>
                  <button
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
                      isLocked
                        ? "border-wp-red bg-wp-red/10 text-wp-red"
                        : "border-wp-stone bg-white text-wp-slate hover:bg-wp-stone/40"
                    }`}
                    onClick={() => {
                      const next = new Map(locked);
                      next.set(p.id, !isLocked);
                      setLocked(next);
                    }}
                    disabled={!isChecked}
                    title={isLocked ? "Locked — dates won't change" : "Unlocked — algorithm may shift dates"}
                  >
                    {isLocked ? <Lock size={12} /> : <Unlock size={12} />}
                    {isLocked ? "Locked" : "Unlocked"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-wp-stone px-5 py-3">
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button
          className="btn-primary"
          disabled={selectedCount === 0}
          onClick={onRun}
        >
          Generate proposal
          <ArrowRight size={14} />
        </button>
      </div>
    </>
  );
}

/* --- Filter chip strip --- */

function FilterChips({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: Array<{ id: string; label: string; color: string | null }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-wp-slate">
          <Users size={12} /> {label}
        </div>
        {selected.size > 0 ? (
          <button className="text-xs text-wp-slate underline-offset-2 hover:underline" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.length === 0 ? (
          <span className="text-xs text-wp-slate">None</span>
        ) : (
          options.map((o) => {
            const active = selected.has(o.id);
            return (
              <button
                key={o.id}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                  active
                    ? "border-wp-red bg-wp-red text-white"
                    : "border-wp-stone bg-white text-wp-slate hover:bg-wp-stone/40"
                }`}
                onClick={() => onToggle(o.id)}
              >
                {o.color ? (
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: active ? "white" : o.color }}
                  />
                ) : null}
                {o.label}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* --- Review phase --- */

type ReviewTab = "timeline" | "list";

function ReviewPhase({
  result,
  allProjects,
  lanes,
  teams,
  users,
  onBack,
  onAccept,
}: {
  result: SchedulerResult;
  /** Full workspace project list — the preview Gantt uses this
   *  (with batch items substituted) so dependency arrows and
   *  capacity overloads reflect the hypothetical schedule. */
  allProjects: Project[];
  lanes: SwimLane[];
  teams: Team[];
  users: User[];
  onBack: () => void;
  onAccept: () => void;
}) {
  const [tab, setTab] = useState<ReviewTab>("timeline");
  const [zoom, setZoom] = useState<"6mo" | "1yr">("6mo");

  const changes = result.proposals.filter((p) => p.changed);
  const warnings = result.proposals.filter(
    (p) =>
      p.deadlineViolations.length ||
      p.dependencyViolations.length ||
      p.capacityWarnings.length,
  );

  // Batch items with proposed dates spliced in — this is what the
  // Gantt draws as bars. Order matches result.proposals (which the
  // scheduler already re-sorts back to the user's picked order).
  const projectsById = useMemo(
    () => new Map(allProjects.map((p) => [p.id, p] as const)),
    [allProjects],
  );
  const previewBatch = useMemo<Project[]>(() => {
    const out: Project[] = [];
    for (const prop of result.proposals) {
      const original = projectsById.get(prop.projectId);
      if (!original) continue;
      out.push({ ...original, ...prop.proposedDates });
    }
    return out;
  }, [result.proposals, projectsById]);

  // Context = workspace-wide list with batch items REPLACED by their
  // proposed versions. Passed as `contextProjects` to the Gantt so
  // dep-arrow lookups + capacity overloads reflect the hypothetical.
  const previewContext = useMemo<Project[]>(() => {
    const overrideById = new Map(previewBatch.map((p) => [p.id, p] as const));
    return allProjects.map((p) => overrideById.get(p.id) ?? p);
  }, [allProjects, previewBatch]);

  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div className="rounded-md border border-wp-stone bg-wp-stone/20 p-3 text-sm">
          {result.clean ? (
            <div className="flex items-center gap-2 text-wp-ink">
              <CheckCircle2 size={16} className="text-emerald-600" />
              Clean schedule — no deadline misses, no dependency conflicts, no capacity overloads.
            </div>
          ) : (
            <div className="flex items-start gap-2 text-wp-ink">
              <AlertTriangle size={16} className="mt-0.5 text-amber-600" />
              <div>
                {warnings.length} item{warnings.length === 1 ? "" : "s"} still have warnings
                the algorithm couldn&apos;t resolve. Review below — you can still apply the
                schedule and address them manually.
              </div>
            </div>
          )}
          <div className="mt-2 text-xs text-wp-slate">
            {changes.length} item{changes.length === 1 ? "" : "s"} will move ·{" "}
            {result.proposals.length - changes.length} unchanged
          </div>
        </div>

        {/* Tab bar + (Timeline-only) zoom toggle */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-wp-stone">
            <button
              type="button"
              onClick={() => setTab("timeline")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition ${
                tab === "timeline" ? "bg-wp-red text-white" : "bg-white text-wp-slate hover:bg-wp-stone/40"
              }`}
            >
              <BarChart3 size={12} />
              Timeline
            </button>
            <button
              type="button"
              onClick={() => setTab("list")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition ${
                tab === "list" ? "bg-wp-red text-white" : "bg-white text-wp-slate hover:bg-wp-stone/40"
              }`}
            >
              <List size={12} />
              List
            </button>
          </div>
          {tab === "timeline" && previewBatch.length > 0 ? (
            <div className="inline-flex items-center gap-2 text-xs">
              <span className="text-wp-slate">Timeframe</span>
              <div className="inline-flex overflow-hidden rounded-md border border-wp-stone">
                <button
                  className={`px-2 py-1 ${zoom === "6mo" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
                  onClick={() => setZoom("6mo")}
                >
                  6 months
                </button>
                <button
                  className={`px-2 py-1 ${zoom === "1yr" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
                  onClick={() => setZoom("1yr")}
                >
                  1 year
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {tab === "timeline" ? (
          previewBatch.length === 0 ? (
            <div className="rounded-md border border-dashed border-wp-stone p-6 text-center text-sm text-wp-slate">
              Nothing to schedule.
            </div>
          ) : (
            <>
              {/* Explicit row count + hint so PMs don't wonder whether
                  a missing item was scheduled — original confusion was
                  that the Gantt had its own vertical scroll, hidden
                  behind the modal's outer scrollbar. Now the wrapper
                  only scrolls horizontally; vertical spillover flows
                  to the modal body's single scrollbar. */}
              <div className="text-[11px] text-wp-slate">
                {previewBatch.length} item{previewBatch.length === 1 ? "" : "s"} on the chart{" "}
                <span className="text-wp-slate/70">
                  · scroll the modal for more rows, scroll the chart itself for later dates
                </span>
              </div>
              <div className="overflow-x-auto rounded-md border border-wp-stone">
                <GanttTimeline
                  projects={previewBatch}
                  lanes={lanes}
                  teams={teams}
                  users={users}
                  colorBy="swim_lane"
                  groupBy="none"
                  zoom={zoom}
                  onOpen={() => { /* preview: clicks disabled */ }}
                  readOnly
                  contextProjects={previewContext}
                />
              </div>
            </>
          )
        ) : result.proposals.length === 0 ? (
          <div className="rounded-md border border-dashed border-wp-stone p-6 text-center text-sm text-wp-slate">
            Nothing to schedule.
          </div>
        ) : (
          <ul className="divide-y divide-wp-stone rounded-md border border-wp-stone">
            {result.proposals.map((prop) => (
              <ProposalRow key={prop.projectId} prop={prop} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-wp-stone px-5 py-3">
        <button className="btn-secondary" onClick={onBack}>
          <ArrowLeft size={14} />
          Back
        </button>
        <button
          className="btn-primary"
          onClick={onAccept}
          disabled={changes.length === 0}
        >
          {changes.length === 0
            ? "No changes to apply"
            : `Accept & apply ${changes.length} change${changes.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </>
  );
}

function ProposalRow({ prop }: { prop: ItemProposal }) {
  const totalWarnings =
    prop.deadlineViolations.length +
    prop.dependencyViolations.length +
    prop.capacityWarnings.length;
  const shiftLabel = prop.offsetDays === 0
    ? "no shift"
    : prop.offsetDays > 0
    ? `+${prop.offsetDays} day${prop.offsetDays === 1 ? "" : "s"}`
    : `${prop.offsetDays} day${prop.offsetDays === -1 ? "" : "s"}`;
  return (
    <li className="px-3 py-2.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {prop.locked ? (
              <Lock size={12} className="text-wp-slate" aria-label="Locked" />
            ) : null}
            <span className="truncate font-medium text-wp-ink">{prop.title}</span>
            {totalWarnings > 0 ? (
              <AlertTriangle size={12} className="text-amber-600" />
            ) : null}
          </div>
          <div className="mt-1 text-xs text-wp-slate">
            {prop.originalDates.start_date} → {prop.originalDates.optimization_end_date}
            {prop.changed ? (
              <>
                <ArrowRight size={11} className="mx-1 inline-block align-middle" />
                <span className="font-medium text-wp-ink">
                  {prop.proposedDates.start_date} → {prop.proposedDates.optimization_end_date}
                </span>
                <span className="ml-2 text-wp-slate/80">({shiftLabel})</span>
              </>
            ) : (
              <span className="ml-2 text-emerald-700">already optimal</span>
            )}
          </div>
        </div>
      </div>

      {(prop.deadlineViolations.length ||
        prop.dependencyViolations.length ||
        prop.capacityWarnings.length) ? (
        <ul className="mt-2 space-y-0.5 pl-4 text-xs">
          {prop.deadlineViolations.map((v, i) => (
            <li key={`d${i}`} className="text-rose-600">• Deadline: {v}</li>
          ))}
          {prop.dependencyViolations.map((v, i) => (
            <li key={`dep${i}`} className="text-rose-600">• Dependency: {v}</li>
          ))}
          {prop.capacityWarnings.map((w, i) => (
            <li key={`c${i}`} className="text-amber-700">
              • Capacity: {w.entityName} ({w.kind}) hits {w.peak}/{w.cap} between {w.from} and {w.to}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* --- Done phase --- */

function DonePhase({
  errors,
  total,
  onClose,
}: {
  errors: Array<{ title: string; message: string }>;
  total: number;
  onClose: () => void;
}) {
  const succeeded = total - errors.length;
  return (
    <>
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {errors.length === 0 ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 size={16} />
              Schedule applied — {succeeded} project{succeeded === 1 ? "" : "s"} updated.
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle size={16} />
                {succeeded} of {total} updated. {errors.length} failed.
              </div>
              <div className="mt-1 text-xs">
                The failed items keep their old dates — usually a validation error from the
                server. Fix the underlying issue (missing prior phase dates, etc.) and retry.
              </div>
            </div>
            <ul className="divide-y divide-wp-stone rounded-md border border-wp-stone text-sm">
              {errors.map((e, i) => (
                <li key={i} className="px-3 py-2">
                  <div className="font-medium text-wp-ink">{e.title}</div>
                  <div className="text-xs text-rose-600">{e.message}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="flex items-center justify-end border-t border-wp-stone px-5 py-3">
        <button className="btn-primary" onClick={onClose}>Close</button>
      </div>
    </>
  );
}
