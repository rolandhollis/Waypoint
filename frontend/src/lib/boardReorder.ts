import type { Project } from "./types";

/**
 * Given the current projects snapshot, produce the version that would
 * exist after moving `activeId` into `targetLaneId` at `targetPosition`.
 * Renumbers positions in both the destination lane (splicing in the
 * moved card) and, on cross-lane moves, the source lane (closing the
 * gap) so the resulting snapshot has no ties or holes and matches the
 * shape the server will return.
 *
 * Extracted from BoardView so the Roadmap's Priority-mode drag path
 * can share the same optimistic-cache-update math and stay bit-for-bit
 * identical to what the Board writes. Never mutates its input.
 */
export function reindexAfterMove(
  prev: Project[],
  activeId: string,
  targetLaneId: string | null,
  targetPosition: number,
): Project[] {
  const active = prev.find((p) => p.id === activeId);
  if (!active) return prev;

  const destItems = prev
    .filter((p) => p.swim_lane_id === targetLaneId && p.id !== activeId)
    .sort((a, b) => a.position - b.position);
  const clampedPos = Math.max(0, Math.min(targetPosition, destItems.length));
  destItems.splice(clampedPos, 0, { ...active, swim_lane_id: targetLaneId });
  const destPosById = new Map<string, number>();
  destItems.forEach((p, i) => destPosById.set(p.id, i));

  let srcPosById: Map<string, number> | null = null;
  if (active.swim_lane_id !== targetLaneId) {
    const srcItems = prev
      .filter((p) => p.swim_lane_id === active.swim_lane_id && p.id !== activeId)
      .sort((a, b) => a.position - b.position);
    srcPosById = new Map();
    srcItems.forEach((p, i) => srcPosById!.set(p.id, i));
  }

  return prev.map((p) => {
    if (p.id === activeId) {
      return { ...p, swim_lane_id: targetLaneId, position: destPosById.get(p.id) ?? clampedPos };
    }
    if (destPosById.has(p.id)) return { ...p, position: destPosById.get(p.id)! };
    if (srcPosById?.has(p.id)) return { ...p, position: srcPosById.get(p.id)! };
    return p;
  });
}
