/**
 * Shared helpers for the Discovery → Development → Post-Dev phase
 * cascade. Used by both the "New project" dialog and the detail-panel
 * editor so the two flows show identical defaults and submit an
 * identical, backend-valid payload.
 *
 * The backend's `validatePhaseDates` guard requires that any set field
 * has all upstream anchors set too (e.g. `optimization_start_date`
 * cannot exist without `dev_end_date`). We keep the frontend inputs
 * looking helpful — Post-Dev shows the day Dev ends — by *computing*
 * effective defaults from whatever anchors are present, then on
 * submit promote each visible-but-implicit default into the actual
 * payload.
 */

export type PhaseDateFields = {
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
};

/** Return an ISO YYYY-MM-DD string `days` days after `iso`, or null. */
export function addIsoDays(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Cascade explicit dates through sensible defaults so downstream
 * pickers always show a reasonable starting point once Discovery has
 * a target date.
 *
 * Defaults (only used when the underlying field is null):
 *   dev_start = target                (start dev the day discovery ends)
 *   dev_end   = dev_start + 7 days    (1 week dev by default)
 *   opt_start = dev_end               (optimize the day dev ends)
 *   opt_end   = opt_start + 14 days   (2 weeks of post-dev)
 */
export function effectiveDates(p: PhaseDateFields) {
  const target = p.target_date;
  const devStart = p.dev_start_date ?? target;
  const devEnd = p.dev_end_date ?? addIsoDays(devStart, 7);
  const optStart = p.optimization_start_date ?? devEnd;
  const optEnd = p.optimization_end_date ?? addIsoDays(optStart, 14);
  return { target, devStart, devEnd, optStart, optEnd };
}

/**
 * Given a partial "draft" of phase-date changes, promote every
 * missing-but-implied field to the value the user was looking at.
 * Explicit values in the draft are respected; already-persisted
 * fields (passed via `existing`) are left alone.
 *
 * Used by the detail-panel patch flow (existing = current project row)
 * and the new-project dialog (existing = all-null). Returns a shallow
 * clone of the draft with any implied fields filled in.
 */
export function fillMissingPhaseDates<T extends Partial<PhaseDateFields>>(
  draft: T,
  existing: PhaseDateFields,
): T {
  const touchesDate =
    "start_date" in draft ||
    "target_date" in draft ||
    "dev_start_date" in draft ||
    "dev_end_date" in draft ||
    "optimization_start_date" in draft ||
    "optimization_end_date" in draft;
  if (!touchesDate) return { ...draft };

  const merged: PhaseDateFields = { ...existing, ...(draft as Partial<PhaseDateFields>) };
  const filled: T = { ...draft };

  function ensure(key: keyof PhaseDateFields, computed: string | null) {
    if (key in draft) return; // user explicitly touched it
    if ((merged as Record<string, unknown>)[key] != null) return; // already persisted
    if (computed == null) return; // no sensible default (no upstream anchor)
    (filled as Record<string, unknown>)[key] = computed;
    (merged as Record<string, unknown>)[key] = computed;
  }

  // Recompute the effective cascade after each fill so downstream
  // defaults derive from the just-filled anchor.
  ensure("target_date", effectiveDates(merged).target);
  ensure("dev_start_date", effectiveDates(merged).devStart);
  ensure("dev_end_date", effectiveDates(merged).devEnd);
  ensure("optimization_start_date", effectiveDates(merged).optStart);
  ensure("optimization_end_date", effectiveDates(merged).optEnd);
  return filled;
}

/** All-null starting state for a brand-new project. */
export const emptyPhaseDates: PhaseDateFields = {
  start_date: null,
  target_date: null,
  dev_start_date: null,
  dev_end_date: null,
  optimization_start_date: null,
  optimization_end_date: null,
};

/**
 * Ordered from earliest to latest — the same non-decreasing chain the
 * backend's `validatePhaseDates` enforces. Used to walk upstream /
 * downstream when the PM stamps a single phase date and we need to
 * make sure the payload doesn't violate ordering.
 */
export const PHASE_DATE_ORDER = [
  "start_date",
  "target_date",
  "dev_start_date",
  "dev_end_date",
  "optimization_start_date",
  "optimization_end_date",
] as const satisfies readonly (keyof PhaseDateFields)[];

/**
 * Human-readable label for a phase-date field. Kept in one place so
 * every prompt/hint reads the same way to a PM.
 */
export const PHASE_DATE_LABELS: Record<keyof PhaseDateFields, string> = {
  start_date: "discovery start",
  target_date: "ready-for-dev date",
  dev_start_date: "development start",
  dev_end_date: "development end",
  optimization_start_date: "post-dev start",
  optimization_end_date: "post-dev end",
};

/**
 * Stamp a single phase-date field to `value` and return a *patch* that
 * also fixes any upstream fields that would otherwise violate
 * `start ≤ target ≤ devStart ≤ devEnd ≤ optStart ≤ optEnd`.
 *
 * Rules:
 *   - The named field is always set to `value`.
 *   - Every upstream field that is either null OR greater than
 *     `value` is pulled down to `value`. This is what makes it safe
 *     for a PM to click "In Dev → today" on a project with no dates
 *     at all: target_date and start_date get backfilled.
 *   - Downstream fields are left alone unless they're explicitly set
 *     to a value earlier than `value`, in which case they're bumped
 *     forward. Downstream nulls stay null — the user hasn't
 *     committed to them yet.
 */
export function stampPhaseDate(
  existing: PhaseDateFields,
  key: keyof PhaseDateFields,
  value: string,
): Partial<PhaseDateFields> {
  const patch: Partial<PhaseDateFields> = { [key]: value };
  const idx = PHASE_DATE_ORDER.indexOf(key);
  if (idx < 0) return patch;

  for (let i = 0; i < idx; i++) {
    const upstream = PHASE_DATE_ORDER[i]!;
    const current = existing[upstream];
    if (current == null || current > value) {
      patch[upstream] = value;
    }
  }
  for (let i = idx + 1; i < PHASE_DATE_ORDER.length; i++) {
    const downstream = PHASE_DATE_ORDER[i]!;
    const current = existing[downstream];
    if (current != null && current < value) {
      patch[downstream] = value;
    }
  }
  return patch;
}

/** Today in the browser's timezone, formatted YYYY-MM-DD. */
export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
