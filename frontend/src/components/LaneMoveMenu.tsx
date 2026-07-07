import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { ApiError, api } from "../lib/api";
import type { Project, SwimLane } from "../lib/types";
import { useMe } from "../lib/queries";

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
  const canWrite = me.data?.role !== "viewer";

  const moveMutation = useMutation({
    mutationFn: (v: { swim_lane_id: string | null }) => api(`/projects/${projectId}/move`, {
      method: "POST",
      body: JSON.stringify({ swim_lane_id: v.swim_lane_id }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
    },
    onError: alertMutationError,
  });
  const deleteMutation = useMutation({
    mutationFn: () => api<Project>(`/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: alertMutationError,
  });

  if (!canWrite) return null;

  return (
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
              if (confirm("Archive this card? You can restore it from the admin view later.")) {
                deleteMutation.mutate();
              }
            }}
            className="cursor-pointer rounded px-2 py-1.5 text-red-600 outline-none hover:bg-red-50"
          >
            Archive
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
