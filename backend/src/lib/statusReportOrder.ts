/**
 * Swim-lane ordering for status reports and digest emails.
 * Reversed from board column order so Complete and later lanes
 * appear first; unassigned / missing lane order sinks to the bottom.
 */
export function compareSwimLaneReportOrder(
  orderA: number | null | undefined,
  orderB: number | null | undefined,
  labelA = "",
  labelB = "",
): number {
  const aMissing = orderA == null;
  const bMissing = orderB == null;
  if (aMissing && !bMissing) return 1;
  if (!aMissing && bMissing) return -1;
  if (!aMissing && !bMissing && orderA !== orderB) return orderB! - orderA!;
  return labelA.localeCompare(labelB);
}
