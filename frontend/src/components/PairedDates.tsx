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
  endLabel,
  endValue,
  endMin,
  onEndChange,
  disabled,
}: {
  startLabel: string;
  startValue: string | null;
  startMin?: string | null;
  onStartChange: (v: string | null) => void;
  endLabel: string;
  endValue: string | null;
  endMin?: string | null;
  onEndChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
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
      </label>
      <span className="pb-2 text-wp-slate/60" aria-hidden>→</span>
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
      </label>
    </div>
  );
}
