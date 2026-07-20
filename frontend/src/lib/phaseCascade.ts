/**
 * Shared phase-cascade primitives used by any surface that sets a
 * single phase's length and needs the OTHER phases to shift to preserve
 * their lengths / ordering.
 *
 * Extracted from EZEstimatesView so the Project Detail Panel can share
 * the same math when accepting a Claude suggestion — the two views
 * disagree on how to handle side effects (row-toast vs. quiet PATCH)
 * but agree byte-for-byte on the DATE arithmetic and phase-key
 * mappings, so keeping them in one file guarantees drift can't sneak
 * in between them.
 *
 * See `aiEstimateApply.ts` for the AI-popover accept-handler factory
 * that builds on top of this module.
 */
import { addIsoDays, todayIso, type PhaseDateFields } from "./phaseDates";
import type { Project } from "./types";

/**
 * Phase definitions used by both the cascade helper and the row
 * renderer. Ordered earliest → latest so the cascade loop can walk
 * from the touched phase forward.
 */
export const PHASES = [
  { key: "discovery",   label: "Discovery",   startField: "start_date",              endField: "target_date"           },
  { key: "development", label: "Development", startField: "dev_start_date",          endField: "dev_end_date"          },
  { key: "postDev",     label: "Post-Dev",    startField: "optimization_start_date", endField: "optimization_end_date" },
] as const;

export type PhaseDef = (typeof PHASES)[number];
export type PhaseKey = PhaseDef["key"];

/**
 * The AI estimator (backend/src/ai/estimator.ts) speaks a snake_case
 * phase key set that mirrors the DB / API surface, while EZEstimates
 * has always used the mixed-case `PhaseKey` above. Rather than break
 * either callsite, this table bridges the two so any consumer of the
 * popover's `[Accept]` buttons can dispatch into the SAME cascade
 * helper the manual picker uses.
 */
export const AI_TO_EZ_PHASE: Record<
  "discovery" | "development" | "post_dev",
  PhaseKey
> = {
  discovery: "discovery",
  development: "development",
  post_dev: "postDev",
};

/**
 * Inverse of {@link AI_TO_EZ_PHASE} — bridge from the mixed-case
 * `PhaseKey` back to the snake_case set the backend uses in
 * `_meta.editedPhases`. The two enums exist for historical reasons
 * (see comment at AI_TO_EZ_PHASE); this table is the single place
 * that flips them.
 */
export const EZ_TO_BACKEND_PHASE: Record<PhaseKey, "discovery" | "development" | "post_dev"> = {
  discovery: "discovery",
  development: "development",
  postDev: "post_dev",
};

/**
 * Fields on `Project` the cascade may touch. Narrowed to just the
 * six phase-date columns so TypeScript can prove we never write
 * something unexpected via the PATCH body.
 */
export type PhaseDatePatch = Partial<PhaseDateFields>;

/** Count of whole days from `from` → `to`. Positive when `to` is
 *  later. Both inputs are YYYY-MM-DD strings. */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * Cascade computation for a single-phase size pick.
 *
 * Given a project, the phase the user just sized, and the new day
 * count, produces a minimal PATCH body that:
 *
 *   1. Sets the sized phase to (existing start, start + N).
 *      - If the phase had no start, uses today.
 *      - The size the caller picked ALWAYS wins for that phase; we
 *        never keep the old end.
 *
 *   2. Cascades any change to subsequent phases:
 *
 *      Case A (touched phase had a persisted end date):
 *        delta = newEnd − oldEnd
 *        Every subsequent phase that has ANY date set shifts every
 *        set date by `delta`. Preserves phase LENGTHS and the
 *        pairwise "dev starts after discovery ends, opt starts after
 *        dev ends" constraint the backend enforces.
 *
 *      Case B (touched phase had NO persisted end date — fresh
 *      stamp of both start and end):
 *        We can't compute a signed delta. Instead each subsequent
 *        phase with dates gets the MINIMUM forward shift needed to
 *        satisfy the boundary constraint against the running
 *        upstream-end anchor. Phases already comfortably after the
 *        touched phase's new end don't move at all.
 *
 *   3. Never fills a subsequent phase that was fully blank. A blank
 *      Development stays blank when the caller only sizes Discovery.
 *
 * The output is *exactly* the patch fields that changed — no
 * spurious keys that the backend would then audit-log as "no-op"
 * edits.
 */
export function computeCascadePatch(
  project: Pick<
    Project,
    | "start_date"
    | "target_date"
    | "dev_start_date"
    | "dev_end_date"
    | "optimization_start_date"
    | "optimization_end_date"
  >,
  phaseKey: PhaseKey,
  newDays: number,
  today: string = todayIso(),
): PhaseDatePatch {
  const idx = PHASES.findIndex((p) => p.key === phaseKey);
  if (idx < 0) return {};
  const phase = PHASES[idx]!;

  const oldStart = project[phase.startField] as string | null;
  const oldEnd   = project[phase.endField]   as string | null;

  // When this phase has no persisted start we normally fall back to
  // today — but the backend enforces a non-decreasing chain across
  // every non-null phase date, so "today" would 400 on any project
  // whose upstream phase (Discovery target, Dev end, …) hasn't
  // elapsed yet. Walk the preceding phases and pull the fallback
  // forward past the latest set upstream date so the PATCH lands.
  let earliestStart = today;
  for (let i = 0; i < idx; i++) {
    const up = PHASES[i]!;
    const upS = project[up.startField] as string | null;
    const upE = project[up.endField]   as string | null;
    if (upS && upS > earliestStart) earliestStart = upS;
    if (upE && upE > earliestStart) earliestStart = upE;
  }
  const newStart = oldStart ?? earliestStart;
  const newEnd = addIsoDays(newStart, newDays)!;

  const patch: PhaseDatePatch = {};
  if (newStart !== oldStart) patch[phase.startField] = newStart;
  if (newEnd !== oldEnd)     patch[phase.endField]   = newEnd;

  // Delta cascade only fires when the touched phase already had an
  // end date to measure against. Fresh stamps use the boundary-
  // preserving branch below.
  const hadOldEnd = !!oldEnd;
  const delta = hadOldEnd ? daysBetween(oldEnd!, newEnd) : 0;

  // Running upstream-end anchor. When the touched phase's new end
  // pushes forward, this drives the "min forward shift" the
  // boundary branch needs for each downstream phase in turn.
  let anchorEnd = newEnd;

  for (let i = idx + 1; i < PHASES.length; i++) {
    const p = PHASES[i]!;
    const pStart = project[p.startField] as string | null;
    const pEnd   = project[p.endField]   as string | null;

    if (!pStart && !pEnd) continue;

    let shift: number;
    if (hadOldEnd) {
      // Case A: uniform delta preserves the length AND the gap to
      // the previous phase. Works for both extensions and shrinks.
      shift = delta;
    } else {
      // Case B: only shift as much as we need to keep this phase's
      // earliest set date on or after the running upstream anchor.
      // Already-set future dates that are well clear of the touched
      // phase are left alone.
      const earliest = pStart ?? pEnd!;
      shift = earliest < anchorEnd ? daysBetween(earliest, anchorEnd) : 0;
    }

    if (shift !== 0) {
      if (pStart) {
        const nextStart = addIsoDays(pStart, shift)!;
        if (nextStart !== pStart) patch[p.startField] = nextStart;
      }
      if (pEnd) {
        const nextEnd = addIsoDays(pEnd, shift)!;
        if (nextEnd !== pEnd) patch[p.endField] = nextEnd;
      }
    }

    // Advance the anchor to this phase's (post-shift) end so the
    // next downstream phase measures against the correct boundary.
    // Falls back to start when end is unset — start-only phases are
    // legal under the pairwise validator, just unusual.
    const finalEnd = pEnd
      ? addIsoDays(pEnd, shift)!
      : pStart
      ? addIsoDays(pStart, shift)!
      : anchorEnd;
    anchorEnd = finalEnd;
  }

  return patch;
}
