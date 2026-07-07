import { usePendingStatus, useProjectStatusUpdates } from "../lib/queries";
import type { WeeklyStatusUpdate } from "../lib/types";

/**
 * Return the current week's status update for a given project.
 * Combines the project's own status_updates history with the current
 * pending list so we don't miss brand-new drafts.
 */
export function useProjectCurrentWeekStatus(projectId: string): (WeeklyStatusUpdate & { due_at: string }) | null {
  const pending = usePendingStatus();
  const updates = useProjectStatusUpdates(projectId);
  const currentWeek = pending.data?.week_of;
  if (!currentWeek) return null;

  const match = updates.data?.find((u) => u.week_of === currentWeek);
  if (match) return match;

  const pendingRow = pending.data?.pending.find((p) => p.project_id === projectId);
  return pendingRow?.existing_update ?? null;
}
