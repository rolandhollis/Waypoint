import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { usePendingStatus, useProjectStatusUpdates } from "../lib/queries";
import type { HealthFlag, WeeklyStatusUpdate } from "../lib/types";
import { StatusPill } from "./StatusPill";
import { HealthFlagSelect } from "./HealthFlagSelect";
import { format } from "date-fns";

const SOFT_SUMMARY_LIMIT = 400;

export function StatusUpdateForm({ projectId }: { projectId: string }) {
  const pending = usePendingStatus();
  const updates = useProjectStatusUpdates(projectId);
  const qc = useQueryClient();

  const currentWeek = pending.data?.week_of ?? new Date().toISOString().slice(0, 10);
  const dueAt = pending.data?.due_at ?? null;
  const existing =
    updates.data?.find((u) => u.week_of === currentWeek) ??
    pending.data?.pending.find((p) => p.project_id === projectId)?.existing_update ??
    null;

  const [flag, setFlag] = useState<HealthFlag | "">((existing?.health_flag as HealthFlag | undefined) === "white" ? "" : (existing?.health_flag ?? ""));
  const [summary, setSummary] = useState(existing?.executive_summary ?? "");
  const [bullets, setBullets] = useState<string[]>(existing?.detailed_update?.length ? existing.detailed_update : []);

  useEffect(() => {
    setFlag((existing?.health_flag as HealthFlag | undefined) === "white" ? "" : (existing?.health_flag ?? ""));
    setSummary(existing?.executive_summary ?? "");
    setBullets(existing?.detailed_update?.length ? existing.detailed_update : []);
  }, [existing?.id, projectId]);

  const cleanBullets = bullets.map((b) => b.trim()).filter(Boolean);
  const canSubmit = !!flag;
  const overdue = dueAt ? new Date(dueAt) < new Date() && !existing?.completed : false;

  const mutation = useMutation({
    mutationFn: (v: { completed: boolean }) => api<WeeklyStatusUpdate>(`/projects/${projectId}/status-updates`, {
      method: "POST",
      body: JSON.stringify({
        week_of: currentWeek,
        health_flag: flag || undefined,
        executive_summary: summary,
        detailed_update: cleanBullets,
        completed: v.completed,
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectStatusUpdates", projectId] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
      qc.invalidateQueries({ queryKey: ["statusReport"] });
    },
  });

  return (
    <div className="mt-2 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs text-wp-slate">
          Week of {currentWeek}
          {dueAt ? <> · due {format(new Date(dueAt), "EEE MMM d, h:mm a")} {overdue ? <span className="ml-1 font-semibold text-red-600">(OVERDUE)</span> : null}</> : null}
        </div>
        {existing ? <StatusPill flag={existing.health_flag} completed={existing.completed} size="md" /> : null}
      </div>

      <div>
        <label className="text-xs font-medium text-wp-slate">Health flag</label>
        <div className="mt-1">
          <HealthFlagSelect value={flag} onChange={setFlag} />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-wp-slate">Executive overview <span className="text-wp-slate/70">(1–2 sentences)</span></label>
        <textarea
          className="input min-h-[3.5rem]"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={SOFT_SUMMARY_LIMIT * 2}
        />
        <div className={`text-right text-[10px] ${summary.length > SOFT_SUMMARY_LIMIT ? "text-orange-600" : "text-wp-slate"}`}>
          {summary.length} / {SOFT_SUMMARY_LIMIT}
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-wp-slate">Detailed update <span className="text-wp-slate/70">(optional)</span></label>
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

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ completed: false })}
        >
          Save draft
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!canSubmit || mutation.isPending}
          title={canSubmit ? undefined : "Pick a health flag first"}
          onClick={() => mutation.mutate({ completed: true })}
        >
          {existing?.completed ? "Update submission" : "Submit"}
        </button>
      </div>
    </div>
  );
}
