import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { usePendingStatus, useProjectStatusUpdates, useProjects } from "../lib/queries";
import type { HealthFlag, WeeklyStatusUpdate } from "../lib/types";
import { StatusPill } from "./StatusPill";
import { HealthFlagSelect } from "./HealthFlagSelect";

const SOFT_SUMMARY_LIMIT = 400;

/**
 * Focused single-purpose modal for entering this week's status update from
 * the Status Report view. Shows only the fields the PRD lists (health,
 * executive summary, optional detail bullets) and a single Save button that
 * submits and closes on success.
 */
export function StatusUpdateModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const pending = usePendingStatus();
  const updates = useProjectStatusUpdates(projectId);
  const projects = useProjects();
  const qc = useQueryClient();

  const project = projects.data?.find((p) => p.id === projectId);
  const currentWeek = pending.data?.week_of ?? new Date().toISOString().slice(0, 10);
  const dueAt = pending.data?.due_at ?? null;
  const existing =
    updates.data?.find((u) => u.week_of === currentWeek) ??
    pending.data?.pending.find((p) => p.project_id === projectId)?.existing_update ??
    null;

  const [flag, setFlag] = useState<HealthFlag | "">(
    existing && existing.health_flag !== "white" ? existing.health_flag : "",
  );
  const [summary, setSummary] = useState(existing?.executive_summary ?? "");
  const [bullets, setBullets] = useState<string[]>(
    existing?.detailed_update?.length ? existing.detailed_update : [],
  );

  // Reset local state whenever the underlying update loads/changes (e.g. after
  // navigation between rows).
  useEffect(() => {
    setFlag(existing && existing.health_flag !== "white" ? existing.health_flag : "");
    setSummary(existing?.executive_summary ?? "");
    setBullets(existing?.detailed_update?.length ? existing.detailed_update : []);
  }, [existing?.id, projectId]);

  const cleanBullets = bullets.map((b) => b.trim()).filter(Boolean);
  const canSubmit = !!flag && cleanBullets.length <= 10;
  const overdue = dueAt ? new Date(dueAt) < new Date() && !existing?.completed : false;

  const save = useMutation({
    mutationFn: () => api<WeeklyStatusUpdate>(`/projects/${projectId}/status-updates`, {
      method: "POST",
      body: JSON.stringify({
        week_of: currentWeek,
        health_flag: flag || undefined,
        executive_summary: summary,
        detailed_update: cleanBullets,
        completed: true,
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectStatusUpdates", projectId] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
      qc.invalidateQueries({ queryKey: ["statusReport"] });
      onClose();
    },
  });

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-base font-semibold text-wp-ink">
                {project?.title ?? "Weekly status"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-wp-slate">
                Week of {currentWeek}
                {dueAt ? <> · due {format(new Date(dueAt), "EEE MMM d, h:mm a")}</> : null}
                {overdue ? <span className="ml-1 font-semibold text-red-600">(OVERDUE)</span> : null}
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              {existing ? <StatusPill flag={existing.health_flag} completed={existing.completed} size="md" /> : null}
              <button aria-label="Close" className="btn-ghost !p-1" onClick={onClose}><X size={18} /></button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <span className="text-xs font-medium text-wp-slate">Status</span>
              <div className="mt-1">
                <HealthFlagSelect
                  value={flag}
                  onChange={setFlag}
                  autoFocus
                  ariaLabel="Status"
                />
              </div>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-wp-slate">Headline <span className="text-wp-slate/70">(1–2 sentences, for executives)</span></span>
              <textarea
                className="input mt-1 min-h-[3.5rem]"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                maxLength={SOFT_SUMMARY_LIMIT * 2}
              />
              <div className={`text-right text-[10px] ${summary.length > SOFT_SUMMARY_LIMIT ? "text-orange-600" : "text-wp-slate"}`}>
                {summary.length} / {SOFT_SUMMARY_LIMIT}
              </div>
            </label>

            <div>
              <span className="text-xs font-medium text-wp-slate">Detailed update <span className="text-wp-slate/70">(optional)</span></span>
              <div className="mt-1 space-y-1.5">
                {bullets.map((b, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="input flex-1"
                      value={b}
                      onChange={(e) => setBullets((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    <button
                      type="button"
                      className="btn-ghost !p-1 text-wp-slate"
                      aria-label="Remove bullet"
                      onClick={() => setBullets((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={bullets.length >= 10}
                  onClick={() => setBullets((prev) => [...prev, ""])}
                >
                  <Plus size={12} /> Add bullet
                </button>
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between">
            <p className="text-xs text-wp-slate">
              {canSubmit ? "Ready to save." : "Pick a status to save."}
            </p>
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!canSubmit || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
