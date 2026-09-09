import { format, subDays } from "date-fns";
import type { ReactNode } from "react";

export function homeTodayKey(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function homeDaysAgoKey(n: number): string {
  return format(subDays(new Date(), n), "yyyy-MM-dd");
}

export function HomeDateRangeFilters({
  from,
  to,
  onFrom,
  onTo,
  onResetLast7,
  rangeError,
  extra,
  embedded = false,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onResetLast7: () => void;
  rangeError: string | null;
  extra?: ReactNode;
  /** When true, render controls without a separate card shell. */
  embedded?: boolean;
}) {
  const body = (
    <>
      <div className="flex flex-wrap items-end gap-3">
        {extra}
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-wp-slate">From</span>
          <input
            type="date"
            className="rounded-md border border-wp-stone bg-white px-2 py-1.5 text-sm text-wp-ink"
            value={from}
            max={to || undefined}
            onChange={(e) => onFrom(e.target.value)}
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-wp-slate">To</span>
          <input
            type="date"
            className="rounded-md border border-wp-stone bg-white px-2 py-1.5 text-sm text-wp-ink"
            value={to}
            min={from || undefined}
            onChange={(e) => onTo(e.target.value)}
          />
        </label>
        <button type="button" className="btn-secondary !py-1.5 !text-xs" onClick={onResetLast7}>
          Last 7 days
        </button>
      </div>
      {rangeError ? <p className="mt-3 text-sm text-wp-red">{rangeError}</p> : null}
    </>
  );

  if (embedded) return <div>{body}</div>;
  return <section className="card-surface p-4">{body}</section>;
}
