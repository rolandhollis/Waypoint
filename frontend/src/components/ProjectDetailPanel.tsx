import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { api } from "../lib/api";
import type { Project, ProjectTimelineEntry, ProjectType, Team, WeeklyStatusUpdate } from "../lib/types";
import { useCanWrite, useCurrentGroupRole, useKpis, useMe, useProjectHistory, useProjects, useProjectStatusUpdates, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { computePhases } from "../lib/phaseCompute";
import { effectiveDates, fillMissingPhaseDates } from "../lib/phaseDates";
import { ancestors, childrenByParent, descendants, indexById } from "../lib/hierarchy";
import { CapacityWarning } from "./CapacityWarning";
import { computeOverloads, overloadsForProject } from "../lib/capacity";
import { KpiPicker } from "./KpiPicker";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { PairedDates } from "./PairedDates";
import { ProjectComments } from "./ProjectComments";
import { ProjectDeadlines } from "./ProjectDeadlines";
import { ProjectDependencies } from "./ProjectDependencies";
import { ProjectPicker } from "./ProjectPicker";
import { StatusPill } from "./StatusPill";
import { StatusUpdateForm } from "./StatusUpdateForm";
import { TagPicker } from "./TagPicker";
import { TeamMultiSelect } from "./TeamMultiSelect";

type Draft = Partial<Project>;

export function ProjectDetailPanel({
  id,
  onClose,
  onOpenProject,
}: {
  id: string;
  onClose: () => void;
  /**
   * Optional handler the parent view passes so breadcrumb / children
   * clicks can swap the currently-selected project without closing the
   * panel. Views that don't supply it fall back to a plain close.
   */
  onOpenProject?: (nextId: string) => void;
}) {
  const me = useMe();
  // Write / role checks go through the per-group hooks so a user
  // who's owner in RMN but viewer in VC sees the read-only version
  // of the panel while browsing VC's cards, and vice versa.
  const canWrite = useCanWrite();
  const currentRole = useCurrentGroupRole();
  const lanes = useSwimLanes();
  const users = useUsers();
  const teams = useTeams();
  const kpis = useKpis();
  const allProjects = useProjects();
  const qc = useQueryClient();

  // Union of every tag currently used across the workspace — powers the
  // TagPicker's suggestion list so PMs pick from existing labels rather
  // than accidentally creating "ui", "UI", and "u.i" variants.
  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of allProjects.data ?? []) for (const t of p.tags) set.add(t);
    return Array.from(set);
  }, [allProjects.data]);

  const projectQuery = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<Project>(`/projects/${id}`),
  });
  const history = useProjectHistory(id);
  const statusUpdates = useProjectStatusUpdates(id);

  const [draft, setDraft] = useState<Draft>({});
  useEffect(() => {
    setDraft({});
  }, [id]);

  const patch = useMutation({
    mutationFn: (body: Draft) => api<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      qc.setQueryData(["project", id], updated);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectStatusUpdates", id] });
      qc.invalidateQueries({ queryKey: ["projectHistory", id] });
      setDraft({});
      onClose();
    },
  });

  const archive = useMutation({
    mutationFn: () => api<Project>(`/projects/${id}/archive`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", id] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
      onClose();
    },
  });

  // IMPORTANT: every hook below runs on *every* render, even before
  // the project fetch resolves, so the hook order stays stable across
  // the loading → loaded transition. React error #310 fires the moment
  // an early return skips downstream hooks; adding useKpis above
  // shifted the count and started tripping it deterministically.
  //
  // Convention: `maybeProject` / `maybeMerged` are nullable and used
  // only in the hooks below. After the null-check we shadow them with
  // the plain `project` / `merged` names so all downstream JSX stays
  // ergonomic (Project, not Project|null).
  const maybeProject = projectQuery.data ?? null;
  const maybeMerged: Project | null = maybeProject
    ? ({ ...maybeProject, ...draft } as Project)
    : null;

  const projectList = allProjects.data ?? [];
  const byId = useMemo(() => indexById(projectList), [projectList]);
  const kids = useMemo(() => childrenByParent(projectList), [projectList]);
  const parentChain = useMemo(
    () => (maybeMerged ? ancestors(maybeMerged.id, byId).reverse() : []),
    [maybeMerged?.id, byId],
  );
  const excludeParentIds = useMemo(() => {
    const s = new Set<string>();
    if (!maybeMerged) return s;
    s.add(maybeMerged.id);
    for (const d of descendants(maybeMerged.id, kids)) s.add(d.id);
    return s;
  }, [maybeMerged?.id, kids]);

  // Capacity check runs on every draft edit — cheap enough (~sub-ms
  // even with 100 projects) that we don't debounce. Feeds the inline
  // CapacityWarning below the form.
  const draftOverloads = useMemo(() => {
    if (!maybeMerged) return [];
    const all = computeOverloads(projectList, users.data ?? [], teams.data ?? [], maybeMerged);
    return overloadsForProject(all, maybeMerged);
  }, [maybeMerged, projectList, users.data, teams.data]);

  if (!maybeProject || !maybeMerged) return null;
  const project: Project = maybeProject;
  const merged: Project = maybeMerged;

  const phases = computePhases(merged);
  const eff = effectiveDates(merged);
  const owner = users.data?.find((u) => u.id === merged.owner_id);
  const projectTeams = (teams.data ?? []).filter((t) => merged.teams.includes(t.id));
  const lane = lanes.data?.find((l) => l.id === merged.swim_lane_id);
  const requiresStatus = !!lane?.requires_weekly_status;
  const myChildren = kids.get(merged.id) ?? [];
  // Show the archive button whenever the card isn't already in an
  // archive lane. Non-admins never see admin-only lanes in
  // `lanes.data`, so `lane.is_archive` is always false for them and
  // the button appears; the backend resolves the destination lane's
  // id from the archive flag on the server side.
  const inArchive = !!lane?.is_archive;
  const canArchive = canWrite && !inArchive;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-white shadow-xl outline-none">
          <div className="flex items-start justify-between border-b border-wp-stone px-5 py-3">
            <div className="min-w-0 flex-1">
              {/* Type + parent breadcrumb above the title so hierarchy
                  context is the first thing a viewer registers. Clicking
                  a crumb navigates to that ancestor's detail panel. */}
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-wp-slate">
                <TypeBadge type={merged.type} />
                {parentChain.length ? (
                  <>
                    {parentChain.map((a, i) => (
                      <span key={a.id} className="flex items-center gap-1">
                        <button
                          className="max-w-[16rem] truncate text-left text-wp-slate hover:text-wp-ink hover:underline"
                          onClick={() => onOpenProject ? onOpenProject(a.id) : onClose()}
                          title={onOpenProject ? `Open ${a.title}` : "Close and navigate to the parent from the board"}
                        >
                          {a.title}
                        </button>
                        {i < parentChain.length - 1 ? <ChevronRight size={12} /> : null}
                      </span>
                    ))}
                    <ChevronRight size={12} />
                  </>
                ) : null}
              </div>
              <Dialog.Title asChild>
                <input
                  className="input !border-transparent !bg-transparent !p-0 text-lg font-semibold focus:!border-wp-red focus:!bg-white focus:!px-2"
                  value={merged.title}
                  disabled={!canWrite}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                />
              </Dialog.Title>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-wp-slate">
                {lane ? <span>Lane: <span className="text-wp-ink">{lane.name}</span></span> : null}
                {owner ? <span>Owner: <span className="text-wp-ink">{owner.name}</span></span> : null}
                {projectTeams.length ? (
                  <span>
                    Teams:{" "}
                    <span className="text-wp-ink">{projectTeams.map((t) => t.name).join(", ")}</span>
                  </span>
                ) : null}
              </div>
            </div>
            <button aria-label="Close" className="btn-ghost !p-1" onClick={onClose}>
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Owner">
                <select className="input" disabled={!canWrite} value={merged.owner_id ?? ""} onChange={(e) => setDraft((d) => ({ ...d, owner_id: e.target.value || null }))}>
                  <option value="">— Unassigned —</option>
                  {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field label="Teams">
                <TeamMultiSelect
                  teams={teams.data ?? []}
                  value={merged.teams}
                  onChange={(next) => setDraft((d) => ({ ...d, teams: next }))}
                  disabled={!canWrite}
                />
              </Field>
              <Field label="Tags">
                <TagPicker
                  value={merged.tags}
                  onChange={(next) => setDraft((d) => ({ ...d, tags: next }))}
                  suggestions={knownTags}
                  disabled={!canWrite}
                />
              </Field>
              <Field
                label="KPIs"
                className="col-span-2"
                hint={(merged.kpis?.length ?? 0) > 1
                  ? "Drag chips to reorder — first chip is the primary KPI, then secondary, and so on."
                  : undefined}
              >
                <KpiPicker
                  value={merged.kpis ?? []}
                  onChange={(next) => setDraft((d) => ({ ...d, kpis: next }))}
                  kpis={kpis.data ?? []}
                  disabled={!canWrite}
                />
              </Field>
              <Field
                label="Hierarchy"
                className="col-span-2"
                hint={merged.type === "subtask"
                  ? "Extending an end date here also extends its parent (and its ancestors) automatically."
                  : "Subtasks live under this epic. Shrinking an end date is rejected when a subtask still needs the room."}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-4">
                    {(["epic", "subtask"] as ProjectType[]).map((t) => (
                      <label key={t} className="flex cursor-pointer items-center gap-2 text-sm text-wp-ink">
                        <input
                          type="radio"
                          name={`project-type-${id}`}
                          value={t}
                          disabled={!canWrite}
                          checked={merged.type === t}
                          onChange={() => setDraft((d) => ({
                            ...d,
                            type: t,
                            // Flipping to epic clears the parent; flipping
                            // to subtask keeps whatever parent is currently
                            // set (or leaves it null for the picker to fill).
                            parent_id: t === "epic" ? null : d.parent_id ?? project.parent_id,
                          }))}
                        />
                        <span className="capitalize">{t}</span>
                      </label>
                    ))}
                  </div>
                  {merged.type === "subtask" ? (
                    <div className="min-w-0 flex-1">
                      <ProjectPicker
                        value={merged.parent_id}
                        onChange={(next) => setDraft((d) => ({ ...d, parent_id: next }))}
                        projects={projectList}
                        excludeIds={excludeParentIds}
                        disabled={!canWrite}
                        placeholder="— Pick a parent —"
                      />
                    </div>
                  ) : null}
                </div>
              </Field>
              <Field label="Discovery and Definition" className="col-span-2">
                <PairedDates
                  startLabel="Start"
                  startValue={merged.start_date}
                  onStartChange={(v) => setDraft((d) => cascadeClear({ ...d, start_date: v }, project))}
                  endLabel="Ready for dev"
                  endValue={merged.target_date}
                  endMin={merged.start_date}
                  onEndChange={(v) => setDraft((d) => cascadeClear({ ...d, target_date: v }, project))}
                  disabled={!canWrite}
                />
              </Field>
              <Field label="Development" className="col-span-2" hint={!eff.target ? "Set Discovery ‘Ready for dev’ first — Development picks up from there." : undefined}>
                <PairedDates
                  startLabel="Start"
                  startValue={eff.devStart}
                  startMin={eff.target}
                  onStartChange={(v) => setDraft((d) => cascadeClear({ ...d, dev_start_date: v }, project))}
                  endLabel="End"
                  endValue={eff.devEnd}
                  endMin={eff.devStart}
                  onEndChange={(v) => setDraft((d) => cascadeClear({ ...d, dev_end_date: v }, project))}
                  disabled={!canWrite || !eff.target}
                />
              </Field>
              <Field label="Post-Dev Optimization" className="col-span-2" hint={!eff.target ? "Set Discovery ‘Ready for dev’ first — Post-Dev cascades from there." : undefined}>
                <PairedDates
                  startLabel="Start"
                  startValue={eff.optStart}
                  startMin={eff.devEnd}
                  onStartChange={(v) => setDraft((d) => cascadeClear({ ...d, optimization_start_date: v }, project))}
                  endLabel="End"
                  endValue={eff.optEnd}
                  endMin={eff.optStart}
                  onEndChange={(v) => setDraft((d) => cascadeClear({ ...d, optimization_end_date: v }, project))}
                  disabled={!canWrite || !eff.target}
                />
              </Field>
            </div>

            <Field label="Description" className="mt-4">
              <textarea
                className="input min-h-[8rem]"
                disabled={!canWrite}
                value={merged.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>

            <section className="mt-5">
              <h3 className="text-sm font-semibold text-wp-ink">Predicted timeline</h3>
              {phases.scheduled ? (
                <ul className="mt-1.5 space-y-1 text-xs text-wp-slate">
                  <li>Phase 1 · Discovery/Definition — {format(phases.discovery!.start, "MMM d")} → {format(phases.discovery!.end, "MMM d")}</li>
                  {phases.awaitingDev ? (
                    <li className="text-amber-700">Awaiting Dev — {format(phases.awaitingDev.start, "MMM d")} → {format(phases.awaitingDev.end, "MMM d")}</li>
                  ) : null}
                  <li>Phase 2 · Development — {format(phases.development!.start, "MMM d")} → {format(phases.development!.end, "MMM d")}</li>
                  {phases.awaitingOptimization ? (
                    <li className="text-amber-700">Awaiting Optimization — {format(phases.awaitingOptimization.start, "MMM d")} → {format(phases.awaitingOptimization.end, "MMM d")}</li>
                  ) : null}
                  <li>Phase 3 · Post-Dev Optimization — {format(phases.optimization!.start, "MMM d")} → {format(phases.optimization!.end, "MMM d")}</li>
                </ul>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">
                  Set start, target, dev end, and optimization end dates to plot this project on the Roadmap.
                </p>
              )}
            </section>

            <ProjectDeadlines project={project} />

            <ProjectDependencies project={project} />

            {myChildren.length ? (
              <section className="mt-6">
                <h3 className="text-sm font-semibold text-wp-ink">
                  Subtasks <span className="text-xs font-normal text-wp-slate">({myChildren.length} direct)</span>
                </h3>
                <ul className="mt-2 space-y-1">
                  {myChildren.map((child) => {
                    const childLane = lanes.data?.find((l) => l.id === child.swim_lane_id);
                    const grandkids = kids.get(child.id) ?? [];
                    return (
                      <li key={child.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded border border-transparent px-2 py-1.5 text-left text-sm text-wp-ink hover:border-wp-stone hover:bg-wp-stone/30"
                          onClick={() => onOpenProject ? onOpenProject(child.id) : onClose()}
                          title={`Open ${child.title}`}
                        >
                          <TypeBadge type={child.type} />
                          <span className="min-w-0 flex-1 truncate">{child.title}</span>
                          <span className="text-[11px] text-wp-slate">
                            {childLane?.name ?? "—"}
                            {grandkids.length ? ` · ${grandkids.length} sub` : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {requiresStatus ? (
              <section className="mt-6 rounded-md border border-wp-stone bg-wp-bg p-3">
                <h3 className="text-sm font-semibold text-wp-ink">This week&rsquo;s status</h3>
                <StatusUpdateForm projectId={id} />
              </section>
            ) : null}

            <section className="mt-6">
              <h3 className="text-sm font-semibold text-wp-ink">Weekly status history</h3>
              {statusUpdates.data && statusUpdates.data.length ? (
                <ul className="mt-2 space-y-3">
                  {statusUpdates.data.map((u) => <StatusHistoryRow key={u.id} u={u} />)}
                </ul>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">No status updates yet for this project.</p>
              )}
            </section>

            <section className="mt-6">
              <ProjectComments projectId={id} />
            </section>

            <section className="mt-6">
              <h3 className="text-sm font-semibold text-wp-ink">Audit trail</h3>
              {history.data && history.data.length ? (
                <ol className="mt-2 space-y-1 text-xs text-wp-slate">
                  {/* Backend returns oldest-first (chronological). PMs
                      read the panel like a changelog and want the newest
                      event on top; reverse a shallow copy so the source
                      array stays untouched for any other consumer. */}
                  {history.data.slice().reverse().map((h) => (
                    <HistoryRow key={h.id} h={h} allProjectsById={byId} />
                  ))}
                </ol>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">No activity yet.</p>
              )}
            </section>
          </div>

          {canWrite ? (
            <div className="border-t border-wp-stone bg-white px-5 py-3">
              <CapacityWarning
                intervals={draftOverloads}
                users={users.data ?? []}
                teams={teams.data ?? []}
                className="mb-2"
              />
              <MutationErrorBanner mutation={patch} className="mb-2" />
              <MutationErrorBanner mutation={archive} className="mb-2" />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button className="btn-ghost text-xs" onClick={onClose}>Cancel</button>
                  {canArchive ? (
                    <button
                      type="button"
                      className="btn-ghost text-xs text-wp-slate hover:text-red-600"
                      disabled={archive.isPending}
                      onClick={() => {
                        if (confirm(
                          "Move this item to Archive?\n\nIt will disappear from the board and be hidden from non-admin users. Admins can restore it by moving it back into any other lane.",
                        )) {
                          archive.mutate();
                        }
                      }}
                    >
                      {archive.isPending ? "Archiving…" : "Move to archive"}
                    </button>
                  ) : null}
                </div>
                <button
                  className="btn-primary"
                  disabled={Object.keys(draft).length === 0 || patch.isPending}
                  onClick={() => patch.mutate(fillMissingPhaseDates(draft, project))}
                >
                  {patch.isPending ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-wp-stone bg-white px-5 py-3 text-xs text-wp-slate">
              Viewer — read-only.
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, className, hint, children }: { label: string; className?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-wp-slate">{label}</span>
        {hint ? <span className="text-[10px] italic text-wp-slate/80">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/**
 * When a user edits an earlier phase-date, any explicitly-set later date
 * that would now sit before its predecessor is cleared, restoring the
 * default-cascade behavior. Fields that were already null keep tracking
 * their upstream defaults automatically.
 */
function cascadeClear(next: Draft, base: Project): Draft {
  const m = { ...base, ...next };
  const clear = (k: keyof Draft) => {
    (next as Record<string, unknown>)[k] = null;
    (m as Record<string, unknown>)[k] = null;
  };
  if (m.start_date && m.target_date && m.target_date < m.start_date) clear("target_date");
  if (m.dev_start_date && m.target_date && m.dev_start_date < m.target_date) clear("dev_start_date");
  const effDevStart = m.dev_start_date ?? m.target_date;
  if (m.dev_end_date && effDevStart && m.dev_end_date < effDevStart) clear("dev_end_date");
  if (m.optimization_start_date && m.dev_end_date && m.optimization_start_date < m.dev_end_date) {
    clear("optimization_start_date");
  }
  const effOptStart = m.optimization_start_date ?? m.dev_end_date;
  if (m.optimization_end_date && effOptStart && m.optimization_end_date < effOptStart) {
    clear("optimization_end_date");
  }
  return next;
}

function StatusHistoryRow({ u }: { u: WeeklyStatusUpdate }) {
  return (
    <li className="rounded border border-wp-stone bg-white p-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="font-medium text-wp-ink">Week of {u.week_of}</div>
        <StatusPill flag={u.health_flag} completed={u.completed} size="md" />
      </div>
      {u.executive_summary ? (
        <div className="mt-1 text-wp-slate">{u.executive_summary}</div>
      ) : null}
      {u.detailed_update.length ? (
        <ul className="ml-4 mt-1 list-disc text-wp-slate">
          {u.detailed_update.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

function HistoryRow({ h, allProjectsById }: { h: ProjectTimelineEntry; allProjectsById?: Map<string, Project> }) {
  const users = useUsers();
  const lanes = useSwimLanes();
  const teams = useTeams();
  const kpis = useKpis();
  const who = users.data?.find((u) => u.id === h.user_id)?.name ?? "system";
  return (
    <li className="leading-relaxed">
      <span className="text-wp-slate/80">{format(new Date(h.timestamp), "yyyy-MM-dd HH:mm")}</span>
      {" · "}
      <span>{who}</span>{" "}
      <HistoryRowBody
        entry={h}
        lanes={lanes.data ?? []}
        teams={teams.data ?? []}
        users={users.data ?? []}
        kpis={kpis.data ?? []}
        projectsById={allProjectsById}
      />
    </li>
  );
}

function HistoryRowBody({
  entry,
  lanes,
  teams,
  users,
  kpis,
  projectsById,
}: {
  entry: ProjectTimelineEntry;
  lanes: { id: string; name: string }[];
  teams: Team[];
  users: { id: string; name: string }[];
  kpis: { id: string; name: string }[];
  projectsById?: Map<string, Project>;
}) {
  const strong = (s: string) => <b className="text-wp-ink">{s}</b>;

  if (entry.kind === "create") return <>created this item.</>;
  if (entry.kind === "archive") return <>archived this item.</>;
  if (entry.kind === "restore") return <>restored this item.</>;

  if (entry.kind === "move") {
    const from = lanes.find((l) => l.id === entry.from_swim_lane_id)?.name ?? "—";
    const to = lanes.find((l) => l.id === entry.to_swim_lane_id)?.name ?? "—";
    return <>moved from {strong(from)} → {strong(to)}</>;
  }

  // edit
  const field = entry.field ?? "";
  const label = FIELD_LABELS[field] ?? field;
  const from = entry.from_value;
  const to = entry.to_value;

  // KPIs are ordered: an ADD/REMOVE diff would lose the ranking
  // change, so render the full before/after name list. Falls back to
  // the raw id when a KPI was deleted since the event landed.
  if (field === "kpis") {
    const before = toStrArray(from).map((id) => kpis.find((k) => k.id === id)?.name ?? id);
    const after = toStrArray(to).map((id) => kpis.find((k) => k.id === id)?.name ?? id);
    if (before.length === 0 && after.length === 0) return <>touched {label}.</>;
    if (before.length === 0) return <>set {label} to {strong(after.join(" › "))}.</>;
    if (after.length === 0) return <>cleared {label} (was {strong(before.join(" › "))}).</>;
    return <>changed {label} from {strong(before.join(" › "))} to {strong(after.join(" › "))}.</>;
  }

  // Nice-to-read array diffs for teams and tags: show what was added
  // and removed rather than dumping both full arrays.
  if (field === "teams" || field === "tags") {
    const before = toStrArray(from);
    const after = toStrArray(to);
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    const format = (id: string) =>
      field === "teams" ? teams.find((t) => t.id === id)?.name ?? id : `#${id}`;
    const parts: React.ReactNode[] = [];
    if (added.length) {
      parts.push(
        <span key="add">
          added {strong(added.map(format).join(", "))}
        </span>,
      );
    }
    if (removed.length) {
      parts.push(
        <span key="rm">
          removed {strong(removed.map(format).join(", "))}
        </span>,
      );
    }
    if (!parts.length) return <>touched {label}.</>;
    return (
      <>
        {label}: {parts.map((p, i) => (
          <span key={i}>
            {i > 0 ? "; " : ""}
            {p}
          </span>
        ))}
      </>
    );
  }

  // Description edits: verbose to render inline, so just note the change.
  if (field === "description") {
    if (isBlank(to)) return <>cleared {label}.</>;
    if (isBlank(from)) return <>set {label}.</>;
    return <>edited {label}.</>;
  }

  // Owner: render display names instead of UUIDs.
  if (field === "owner_id") {
    const fromName = isBlank(from) ? null : users.find((u) => u.id === from)?.name ?? String(from);
    const toName = isBlank(to) ? null : users.find((u) => u.id === to)?.name ?? String(to);
    if (fromName == null && toName != null) return <>set {label} to {strong(toName)}.</>;
    if (fromName != null && toName == null) return <>cleared {label}.</>;
    return <>changed {label} from {strong(fromName ?? "—")} to {strong(toName ?? "—")}.</>;
  }

  // Parent-id edits: swap UUIDs for project titles when possible so
  // the trail reads naturally ("re-parented under X"). Fall back to
  // the raw id if the project isn't in the current list (e.g., deleted).
  if (field === "parent_id") {
    const nameFor = (v: unknown) => {
      if (isBlank(v)) return null;
      return projectsById?.get(String(v))?.title ?? String(v);
    };
    const fromName = nameFor(from);
    const toName = nameFor(to);
    if (fromName == null && toName != null) return <>re-parented under {strong(toName)}.</>;
    if (fromName != null && toName == null) return <>promoted to a top-level epic (was under {strong(fromName)}).</>;
    return <>moved from {strong(fromName ?? "—")} to {strong(toName ?? "—")}.</>;
  }

  // Hard-deadline events. field is `deadline:<lane_id>`; from/to are
  // {deadline_date, note} objects (or null on create/delete). We look
  // up the lane name for a friendlier read; falls back to "(deleted
  // lane)" if the lane is gone.
  if (field.startsWith("deadline:")) {
    const laneId = field.slice("deadline:".length);
    const laneName = lanes.find((l) => l.id === laneId)?.name ?? "(deleted lane)";
    const fromD = deadlineValue(from);
    const toD = deadlineValue(to);
    if (!fromD && toD) return <>added {strong(laneName)} deadline on {strong(toD.deadline_date)}.</>;
    if (fromD && !toD) return <>removed the {strong(laneName)} deadline (was {strong(fromD.deadline_date)}).</>;
    if (fromD && toD) {
      const parts: React.ReactNode[] = [];
      if (fromD.deadline_date !== toD.deadline_date) {
        parts.push(<span key="d">date from {strong(fromD.deadline_date)} to {strong(toD.deadline_date)}</span>);
      }
      if ((fromD.note ?? "") !== (toD.note ?? "")) {
        parts.push(<span key="n">updated the note</span>);
      }
      if (!parts.length) return <>touched the {strong(laneName)} deadline.</>;
      return (
        <>
          {strong(laneName)} deadline: {parts.map((p, i) => (
            <span key={i}>{i > 0 ? "; " : ""}{p}</span>
          ))}.
        </>
      );
    }
    return <>touched a deadline.</>;
  }

  // Dependency events. `field = "dependency:<id>"`; from/to are
  // {project_swim_lane_id, depends_on_project_id,
  // depends_on_swim_lane_id, note} on create/delete, or {note} for
  // note-only patches. Uses the projectsById map for readable
  // upstream titles and the lanes list for phase names.
  if (field.startsWith("dependency:")) {
    const fromD = dependencyValue(from);
    const toD = dependencyValue(to);
    const summarize = (d: NonNullable<ReturnType<typeof dependencyValue>>) => {
      const thisLane = d.project_swim_lane_id
        ? lanes.find((l) => l.id === d.project_swim_lane_id)?.name ?? "(deleted lane)"
        : null;
      const otherName = d.depends_on_project_id
        ? projectsById?.get(d.depends_on_project_id)?.title ?? "(deleted project)"
        : null;
      const otherLane = d.depends_on_swim_lane_id
        ? lanes.find((l) => l.id === d.depends_on_swim_lane_id)?.name ?? "(deleted lane)"
        : null;
      if (!thisLane || !otherName || !otherLane) return null;
      return { thisLane, otherName, otherLane };
    };
    const summarizedTo = toD ? summarize(toD) : null;
    const summarizedFrom = fromD ? summarize(fromD) : null;

    if (!fromD && summarizedTo) {
      return (
        <>added dependency: {strong(summarizedTo.thisLane)} blocked by {strong(summarizedTo.otherName)}&rsquo;s {strong(summarizedTo.otherLane)}.</>
      );
    }
    if (summarizedFrom && !toD) {
      return (
        <>removed dependency: {strong(summarizedFrom.thisLane)} blocked by {strong(summarizedFrom.otherName)}&rsquo;s {strong(summarizedFrom.otherLane)}.</>
      );
    }
    // Note-only patch: from/to carry only `note`.
    if (fromD && toD && "note" in fromD && "note" in toD && (fromD.note ?? "") !== (toD.note ?? "")) {
      return <>updated a dependency note.</>;
    }
    return <>touched a dependency.</>;
  }

  // Generic scalar (dates, title, etc.).
  if (isBlank(to)) return <>cleared {label}.</>;
  if (isBlank(from)) return <>set {label} to {strong(String(to))}.</>;
  return <>changed {label} from {strong(String(from))} to {strong(String(to))}.</>;
}

function dependencyValue(v: unknown):
  | {
      project_swim_lane_id?: string;
      depends_on_project_id?: string;
      depends_on_swim_lane_id?: string;
      note?: string;
    }
  | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const asStr = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  return {
    project_swim_lane_id: asStr("project_swim_lane_id"),
    depends_on_project_id: asStr("depends_on_project_id"),
    depends_on_swim_lane_id: asStr("depends_on_swim_lane_id"),
    note: asStr("note"),
  };
}

function deadlineValue(v: unknown): { deadline_date: string; note: string } | null {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const d = obj.deadline_date;
  if (typeof d !== "string") return null;
  return { deadline_date: d, note: typeof obj.note === "string" ? obj.note : "" };
}

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  owner_id: "owner",
  teams: "teams",
  tags: "tags",
  kpis: "KPIs",
  type: "type",
  parent_id: "parent",
  start_date: "discovery start",
  target_date: "discovery target",
  dev_start_date: "development start",
  dev_end_date: "development end",
  optimization_start_date: "post-dev start",
  optimization_end_date: "post-dev end",
  swim_lane_id: "swim lane",
};

function isBlank(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String);
}

/** Compact "epic" / "subtask" chip. Colored to nudge epics as the
 *  primary structural unit. */
function TypeBadge({ type }: { type: ProjectType }) {
  return (
    <span
      className={
        type === "epic"
          ? "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-wp-red/10 text-wp-red"
          : "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-wp-stone/60 text-wp-slate"
      }
    >
      {type}
    </span>
  );
}
