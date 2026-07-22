/**
 * Two `<input type="date">` fields laid out side-by-side with a
 * "start → end" arrow. Used for the Discovery / Development /
 * Post-Dev phase editors on both the new-project form and the detail
 * panel so the two flows look identical.
 */
export function PairedDates({
  startLabel,
  startValue,
  startMin,
  onStartChange,
  startHint,
  endLabel,
  endValue,
  endMin,
  onEndChange,
  endHint,
  disabled,
}: {
  startLabel: string;
  startValue: string | null;
  startMin?: string | null;
  onStartChange: (v: string | null) => void;
  /**
   * Optional muted note rendered directly beneath the start input.
   * Used to disclose things like cascade-default fallbacks
   * (e.g. "Empty — will default to Aug 17, 2026 on the roadmap.")
   * without making the empty picker LOOK filled in.
   */
  startHint?: string;
  endLabel: string;
  endValue: string | null;
  endMin?: string | null;
  onEndChange: (v: string | null) => void;
  /** See `startHint` — same behaviour, rendered under the end input. */
  endHint?: string;
  disabled?: boolean;
}) {
  // `items-start` (rather than the previous `items-end`) keeps the
  // two inputs top-aligned so a hint appearing under only one side
  // doesn't shove that side's input up relative to the other.
  return (
    <div className="flex flex-wrap items-start gap-2">
      <label className="min-w-[10rem] flex-1">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-wp-slate/70">{startLabel}</span>
        <input
          type="date"
          className="input"
          disabled={disabled}
          min={startMin ?? undefined}
          value={startValue ?? ""}
          onChange={(e) => onStartChange(e.target.value || null)}
        />
        {startHint ? (
          <span className="mt-1 block text-[10px] italic leading-snug text-wp-slate/80">
            {startHint}
          </span>
        ) : null}
      </label>
      <span className="mt-6 text-wp-slate/60" aria-hidden>→</span>
      <label className="min-w-[10rem] flex-1">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-wp-slate/70">{endLabel}</span>
        <input
          type="date"
          className="input"
          disabled={disabled}
          min={endMin ?? undefined}
          value={endValue ?? ""}
          onChange={(e) => onEndChange(e.target.value || null)}
        />
        {endHint ? (
          <span className="mt-1 block text-[10px] italic leading-snug text-wp-slate/80">
            {endHint}
          </span>
        ) : null}
      </label>
    </div>
  );
}
