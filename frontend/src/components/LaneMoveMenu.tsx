import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../lib/api";
import type { Project, SwimLane } from "../lib/types";
import { useMe, useProjects } from "../lib/queries";
import { PhaseDatePromptModal } from "./PhaseDatePromptModal";

// Dropdowns close immediately on click so we can't render an inline
// error banner; surface failures via a native alert instead.
function alertMutationError(err: unknown) {
  const msg = err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : "Something went wrong. Try again.";
  alert(msg);
}

export function LaneMoveMenu({
  projectId,
  currentLaneId,
  lanes,
}: {
  projectId: string;
  currentLaneId: string | null;
  lanes: SwimLane[];
}) {
  const me = useMe();
  const qc = useQueryClient();
  const projects = useProjects();
  const canWrite = me.data?.role !== "viewer";
  // When the move lands in a phase-bound lane, open the same
  // update-date modal the board drag-drop flow uses.
  const [phasePromptLaneId, setPhasePromptLaneId] = useState<string | null>(null);

  const moveMutation = useMutation({
    mutationFn: (v: { swim_lane_id: string }) => api(`/projects/${projectId}/move`, {
      method: "POST",
      body: JSON.stringify({ swim_lane_id: v.swim_lane_id }),
    }),
    onSuccess: (_data, v) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
      const destLane = lanes.find((l) => l.id === v.swim_lane_id);
      if (destLane?.phase_date_key) {
        setPhasePromptLaneId(v.swim_lane_id);
      }
    },
    onError: alertMutationError,
  });
  const deleteMutation = useMutation({
    mutationFn: () => api<Project>(`/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: alertMutationError,
  });

  if (!canWrite) return null;

  const promptProject = phasePromptLaneId ? projects.data?.find((p) => p.id === projectId) : undefined;
  const promptLane = phasePromptLaneId ? lanes.find((l) => l.id === phasePromptLaneId) : undefined;

  return (
    <>
    {promptProject && promptLane ? (
      <PhaseDatePromptModal
        project={promptProject}
        lane={promptLane}
        onDismiss={() => setPhasePromptLaneId(null)}
      />
    ) : null}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="btn-ghost !p-1"
          aria-label="Card actions"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[10rem] rounded-md border border-wp-stone bg-white p-1 text-sm shadow-md"
        >
          <DropdownMenu.Label className="px-2 py-1 text-xs uppercase text-wp-slate">Move to…</DropdownMenu.Label>
          {lanes.map((l) => (
            <DropdownMenu.Item
              key={l.id}
              disabled={l.id === currentLaneId}
              onSelect={() => moveMutation.mutate({ swim_lane_id: l.id })}
              className="cursor-pointer rounded px-2 py-1.5 text-wp-ink outline-none data-[disabled]:opacity-40 hover:bg-wp-stone/40"
            >
              {l.name}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-wp-stone" />
          <DropdownMenu.Item
            onSelect={() => {
              if (confirm(
                "Delete this card?\n\nThis is a hard delete — the card disappears from the board and only an admin can restore it from Admin → Archived cards. To keep the card in history but out of everyone's way, use \"Move to archive\" from the card detail instead.",
              )) {
                deleteMutation.mutate();
              }
            }}
            className="cursor-pointer rounded px-2 py-1.5 text-red-600 outline-none hover:bg-red-50"
          >
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    </>
  );
}
