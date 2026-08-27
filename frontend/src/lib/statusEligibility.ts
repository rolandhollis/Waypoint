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

export function laneNameKey(lane: Pick<SwimLane, "name">): string {
  return lane.name.trim().toLowerCase();
}

export function isParkingLotLane(
  lane: Pick<SwimLane, "name"> | null | undefined,
): boolean {
  if (!lane) return false;
  return laneNameKey(lane) === "parking lot";
}

/** Terminal delivery-complete lane (not archive). */
export function isCompleteLane(
  lane: Pick<SwimLane, "name" | "is_terminal" | "is_archive"> | null | undefined,
): boolean {
  if (!lane) return false;
  if (lane.is_archive) return false;
  if (laneNameKey(lane) === "complete") return true;
  return !!lane.is_terminal;
}

/** Lanes omitted from the per-user assignments page. */
export function isHiddenFromUserAssignments(
  lane: Pick<SwimLane, "name" | "is_archive"> | null | undefined,
): boolean {
  if (!lane) return true;
  if (lane.is_archive) return true;
  return isParkingLotLane(lane);
}
