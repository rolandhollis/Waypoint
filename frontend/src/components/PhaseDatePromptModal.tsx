import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { PHASE_DATE_LABELS, stampPhaseDate, todayIso, type PhaseDateFields } from "../lib/phaseDates";
import type { PhaseDateKey, Project, SwimLane } from "../lib/types";
import { MutationErrorBanner } from "./MutationErrorBanner";

/**
 * Post-move prompt: when a card lands in a lane bound to a specific
 * phase date (see swim_lanes.phase_date_key), give the PM a one-click
 * shortcut to stamp that date on the project.
 *
 * Defaults to today. If the PM picks a different date, we also
 * cascade upstream fields (see `stampPhaseDate`) so the payload
 * always satisfies the backend's phase-ordering validator — a card
 * dropped into "In Dev" with no prior dates gets target_date and
 * start_date silently backfilled to the same day.
 */
export function PhaseDatePromptModal({
  project,
  lane,
  onDismiss,
}: {
  project: Project;
  lane: SwimLane;
  onDismiss: () => void;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIso());

  // Guard: this component should only be rendered when the lane
  // has a phase_date_key, but guard defensively so a rename in
  // admin settings doesn't crash the board.
  const key = lane.phase_date_key;
  useEffect(() => {
    if (!key) onDismiss();
  }, [key, onDismiss]);
  if (!key) return null;

  const label = PHASE_DATE_LABELS[key];

  const patch = useMutation({
    mutationFn: () => {
      const existing: PhaseDateFields = {
        start_date: project.start_date,
        target_date: project.target_date,
        dev_start_date: project.dev_start_date,
        dev_end_date: project.dev_end_date,
        optimization_start_date: project.optimization_start_date,
        optimization_end_date: project.optimization_end_date,
      };
      const body = stampPhaseDate(existing, key, date);
      return api<Project>(`/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (updated) => {
      qc.setQueryData(["project", project.id], updated);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", project.id] });
      onDismiss();
    },
  });

  const previouslySet = (project as unknown as Record<string, string | null>)[key];

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onDismiss(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Update {label}?</Dialog.Title>
            <button aria-label="Close" className="btn-ghost !p-1" onClick={onDismiss}>
              <X size={18} />
            </button>
          </div>

          <p className="text-sm text-wp-slate">
            You moved <span className="font-medium text-wp-ink">{project.title}</span> to{" "}
            <span className="font-medium text-wp-ink">{lane.name}</span>. Want to stamp its{" "}
            <span className="font-medium text-wp-ink">{label}</span>?
          </p>
          {previouslySet ? (
            <p className="mt-2 text-xs text-wp-slate/80">
              Currently set to <span className="font-medium text-wp-ink">{previouslySet}</span>. Saving replaces it.
            </p>
          ) : null}

          <label className="mt-3 block text-xs font-medium text-wp-slate">
            Date
            <input
              type="date"
              className="input mt-1"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>

          <MutationErrorBanner mutation={patch} className="mt-3" />

          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={onDismiss} disabled={patch.isPending}>
              Skip
            </button>
            <button
              className="btn-primary"
              disabled={!date || patch.isPending}
              onClick={() => patch.mutate()}
            >
              {patch.isPending ? "Saving…" : "Save date"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
