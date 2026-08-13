import type { SwimLane } from "./types";

/**
 * Backlog (and the admin-designated "default new" landing lane) are
 * pre-discovery holding areas — weekly status prompts should not fire
 * for cards sitting there, even if someone accidentally toggled
 * `requires_weekly_status` on that lane in Admin.
 *
 * Keep this in sync with the SQL filter in
 * `backend/src/routes/statusUpdates.ts` → `eligibleProjects`.
 */
export function isBacklogLane(
  lane: Pick<SwimLane, "name" | "is_default_new"> | null | undefined,
): boolean {
  if (!lane) return false;
  if (lane.is_default_new) return true;
  return lane.name.trim().toLowerCase() === "backlog";
}

/** True when the lane should surface weekly-status UI / chips. */
export function laneRequiresWeeklyStatus(
  lane: Pick<SwimLane, "name" | "is_default_new" | "requires_weekly_status"> | null | undefined,
): boolean {
  return !!lane?.requires_weekly_status && !isBacklogLane(lane);
}
