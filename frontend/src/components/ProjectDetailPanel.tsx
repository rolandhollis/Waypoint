import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import type { Project, ProjectTimelineEntry, Team, WeeklyStatusUpdate } from "../lib/types";
import { useMe, useProjectHistory, useProjects, useProjectStatusUpdates, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { computePhases } from "../lib/phaseCompute";
import { effectiveDates, fillMissingPhaseDates } from "../lib/phaseDates";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { PairedDates } from "./PairedDates";
import { ProjectComments } from "./ProjectComments";
import { StatusPill } from "./StatusPill";
import { StatusUpdateForm } from "./StatusUpdateForm";
import { TagPicker } from "./TagPicker";
import { TeamMultiSelect } from "./TeamMultiSelect";

type Draft = Partial<Project>;

export function ProjectDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const canWrite = me.data?.role !== "viewer";
  const lanes = useSwimLanes();
  const users = useUsers();
  const teams = useTeams();
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

  const project = projectQuery.data;
  if (!project) return null;

  const merged: Project = { ...project, ...draft };
  const phases = computePhases(merged);
  const eff = effectiveDates(merged);
  const owner = users.data?.find((u) => u.id === merged.owner_id);
  const projectTeams = (teams.data ?? []).filter((t) => merged.teams.includes(t.id));
  const lane = lanes.data?.find((l) => l.id === merged.swim_lane_id);
  const requiresStatus = !!lane?.requires_weekly_status;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-white shadow-xl outline-none">
          <div className="flex items-start justify-between border-b border-wp-stone px-5 py-3">
            <div className="min-w-0 flex-1">
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
                  {history.data.map((h) => <HistoryRow key={h.id} h={h} />)}
                </ol>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">No activity yet.</p>
              )}
            </section>
          </div>

          {canWrite ? (
            <div className="border-t border-wp-stone bg-white px-5 py-3">
              <MutationErrorBanner mutation={patch} className="mb-2" />
              <div className="flex items-center justify-between">
                <button className="btn-ghost text-xs" onClick={onClose}>Cancel</button>
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

function HistoryRow({ h }: { h: ProjectTimelineEntry }) {
  const users = useUsers();
  const lanes = useSwimLanes();
  const teams = useTeams();
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
      />
    </li>
  );
}

function HistoryRowBody({
  entry,
  lanes,
  teams,
  users,
}: {
  entry: ProjectTimelineEntry;
  lanes: { id: string; name: string }[];
  teams: Team[];
  users: { id: string; name: string }[];
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

  // Generic scalar (dates, title, etc.).
  if (isBlank(to)) return <>cleared {label}.</>;
  if (isBlank(from)) return <>set {label} to {strong(String(to))}.</>;
  return <>changed {label} from {strong(String(from))} to {strong(String(to))}.</>;
}

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  owner_id: "owner",
  teams: "teams",
  tags: "tags",
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
