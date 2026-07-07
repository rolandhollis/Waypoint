import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import type { Project, StatusHistoryEntry, WeeklyStatusUpdate } from "../lib/types";
import { useMe, useProductAreas, useProjectHistory, useProjectStatusUpdates, useSwimLanes, useUsers } from "../lib/queries";
import { computePhases } from "../lib/phaseCompute";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { StatusPill } from "./StatusPill";
import { StatusUpdateForm } from "./StatusUpdateForm";

type Draft = Partial<Project>;

export function ProjectDetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const canWrite = me.data?.role !== "viewer";
  const lanes = useSwimLanes();
  const users = useUsers();
  const areas = useProductAreas();
  const qc = useQueryClient();

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
      setDraft({});
    },
  });

  const project = projectQuery.data;
  if (!project) return null;

  const merged: Project = { ...project, ...draft };
  const phases = computePhases(merged);
  const owner = users.data?.find((u) => u.id === merged.owner_id);
  const area = areas.data?.find((a) => a.id === merged.product_area_id);
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
                {lane ? <span>Lane: <span className="text-wp-ink">{lane.name}</span></span> : <span>Unassigned lane</span>}
                {owner ? <span>Owner: <span className="text-wp-ink">{owner.name}</span></span> : null}
                {area ? <span>Area: <span className="text-wp-ink">{area.name}</span></span> : null}
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
              <Field label="Product Area">
                <select className="input" disabled={!canWrite} value={merged.product_area_id ?? ""} onChange={(e) => setDraft((d) => ({ ...d, product_area_id: e.target.value || null }))}>
                  <option value="">— Unassigned —</option>
                  {areas.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Tags (comma-separated)">
                <input
                  className="input"
                  disabled={!canWrite}
                  value={merged.tags.join(", ")}
                  onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }))}
                />
              </Field>
              <Field label="Actual completion date">
                <div className="input !bg-wp-stone/30 !text-wp-slate">
                  {merged.actual_completion_date ?? <span className="italic">auto-set when moved to a terminal lane</span>}
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
              <Field label="Development" className="col-span-2" hint={!merged.target_date ? "Set Discovery ‘Ready for dev’ first — Development picks up from there." : undefined}>
                <PairedDates
                  startLabel="Start"
                  startValue={merged.dev_start_date ?? merged.target_date}
                  startMin={merged.target_date}
                  onStartChange={(v) => setDraft((d) => cascadeClear({ ...d, dev_start_date: v }, project))}
                  endLabel="End"
                  endValue={merged.dev_end_date ?? addIsoDays(merged.dev_start_date ?? merged.target_date, 7)}
                  endMin={merged.dev_start_date ?? merged.target_date}
                  onEndChange={(v) => setDraft((d) => cascadeClear({ ...d, dev_end_date: v }, project))}
                  disabled={!canWrite || !merged.target_date}
                />
              </Field>
              <Field label="Post-Dev Optimization" className="col-span-2" hint={!merged.dev_end_date && !merged.target_date ? "Set Discovery and Development dates first." : (!merged.dev_end_date ? "Set a Development end date first." : undefined)}>
                <PairedDates
                  startLabel="Start"
                  startValue={merged.optimization_start_date ?? merged.dev_end_date}
                  startMin={merged.dev_end_date}
                  onStartChange={(v) => setDraft((d) => cascadeClear({ ...d, optimization_start_date: v }, project))}
                  endLabel="End"
                  endValue={
                    merged.optimization_end_date ??
                    addIsoDays(merged.optimization_start_date ?? merged.dev_end_date, 7)
                  }
                  endMin={merged.optimization_start_date ?? merged.dev_end_date}
                  onEndChange={(v) => setDraft((d) => cascadeClear({ ...d, optimization_end_date: v }, project))}
                  disabled={!canWrite || !merged.dev_end_date}
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
              <h3 className="text-sm font-semibold text-wp-ink">Audit trail</h3>
              {history.data && history.data.length ? (
                <ol className="mt-2 space-y-1 text-xs text-wp-slate">
                  {history.data.map((h) => <HistoryRow key={h.id} h={h} />)}
                </ol>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">No lane transitions yet.</p>
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
                  onClick={() => patch.mutate(draft)}
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
 * Symmetric [Start → End] date-pair control used for each phase row so
 * Discovery, Development, and Optimization all look and behave the same.
 * Empty strings coming out of the date input are normalized to null so
 * the draft carries a clear "reset to default" signal to the backend.
 */
function PairedDates({
  startLabel, startValue, startMin, onStartChange,
  endLabel,   endValue,   endMin,   onEndChange,
  disabled,
}: {
  startLabel: string;
  startValue: string | null;
  startMin?: string | null;
  onStartChange: (v: string | null) => void;
  endLabel: string;
  endValue: string | null;
  endMin?: string | null;
  onEndChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-[10rem] flex-1">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-wp-slate/70">{startLabel}</span>
        <input
          type="date"
          className="input"
          disabled={disabled}
          min={startMin ?? undefined}
          value={startValue ?? ""}
          onChange={(e) => onStartChange(e.target.value || null)}
        />
      </label>
      <span className="pb-2 text-wp-slate/60" aria-hidden>→</span>
      <label className="min-w-[10rem] flex-1">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-wp-slate/70">{endLabel}</span>
        <input
          type="date"
          className="input"
          disabled={disabled}
          min={endMin ?? undefined}
          value={endValue ?? ""}
          onChange={(e) => onEndChange(e.target.value || null)}
        />
      </label>
    </div>
  );
}

/** Return an ISO YYYY-MM-DD string `days` days after `iso`, or null. */
function addIsoDays(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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

function HistoryRow({ h }: { h: StatusHistoryEntry }) {
  const users = useUsers();
  const lanes = useSwimLanes();
  const who = users.data?.find((u) => u.id === h.moved_by_user_id)?.name ?? "system";
  const from = lanes.data?.find((l) => l.id === h.from_swim_lane_id)?.name ?? "—";
  const to = lanes.data?.find((l) => l.id === h.to_swim_lane_id)?.name ?? "—";
  return (
    <li>
      {format(new Date(h.timestamp), "yyyy-MM-dd HH:mm")} · {who} moved from <b className="text-wp-ink">{from}</b> → <b className="text-wp-ink">{to}</b>
    </li>
  );
}
