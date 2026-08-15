import { useMemo, useState, type ReactNode } from "react";
import { format, parseISO, subDays } from "date-fns";
import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import {
  useActivityByDay,
  useActivityByUser,
  useMentionableUsers,
} from "../lib/queries";

/**
 * Embedded ZiffSplit slot for the homepage activity chart.
 *
 * Container: `home_activity_chart`
 * Delivery: embedded · contentSource: code
 *
 * codeVariantKey values:
 * - `activity_by_day` (control) — updates per day + optional user filter
 * - `activity_by_user` (variant A) — updates per user + date range pickers
 *
 * When the SDK is off / not assigned, the control UI renders so the
 * homepage stays useful outside an experiment.
 */
export const HOME_ACTIVITY_CHART_CONTAINER = "home_activity_chart";
export const HOME_ACTIVITY_BY_DAY_KEY = "activity_by_day";
export const HOME_ACTIVITY_BY_USER_KEY = "activity_by_user";

function todayKey(): string {
  return format(new Date(), "yyyy-MM-dd");
}

function daysAgoKey(n: number): string {
  return format(subDays(new Date(), n), "yyyy-MM-dd");
}

function useHomeActivityCodeVariant(): string {
  const ab = useAbSdk();
  void ab.previewRevision;

  if (!isAbSdkConfigured() || !ab.ready || ab.error) {
    return HOME_ACTIVITY_BY_DAY_KEY;
  }

  const assignment = ab.getAssignmentByContainer(HOME_ACTIVITY_CHART_CONTAINER);
  if (!assignment || assignment.contentSource !== "code") {
    return HOME_ACTIVITY_BY_DAY_KEY;
  }

  return assignment.codeVariantKey ?? HOME_ACTIVITY_BY_DAY_KEY;
}

function DateRangeFilters({
  from,
  to,
  onFrom,
  onTo,
  onResetLast7,
  rangeError,
  extra,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onResetLast7: () => void;
  rangeError: string | null;
  extra?: ReactNode;
}) {
  return (
    <section className="card-surface p-4">
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
    </section>
  );
}

function ActivityByDayChart() {
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState(() => daysAgoKey(6));
  const [to, setTo] = useState(() => todayKey());

  const users = useMentionableUsers();
  const userOptions = useMemo(
    () => (users.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [users.data],
  );

  const rangeError = from && to && from > to
    ? "Start date must be on or before end date."
    : null;

  const activity = useActivityByDay({
    from,
    to,
    user_id: userId || undefined,
    enabled: !rangeError && !!from && !!to,
  });

  const days = activity.data?.days ?? [];
  const total = activity.data?.total ?? 0;
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  return (
    <div className="space-y-4">
      <DateRangeFilters
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
        onResetLast7={() => {
          setFrom(daysAgoKey(6));
          setTo(todayKey());
        }}
        rangeError={rangeError}
        extra={
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-wp-slate">User</span>
            <select
              className="min-w-[12rem] rounded-md border border-wp-stone bg-white px-2 py-1.5 text-sm text-wp-ink"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">All users</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <section className="card-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-wp-ink">Updates per day</h2>
          <p className="text-xs text-wp-slate">
            {activity.isLoading
              ? "Loading…"
              : `${total} event${total === 1 ? "" : "s"} · ${
                  activity.data?.timezone ?? "local"
                }`}
          </p>
        </div>

        {activity.isError ? (
          <p className="mt-6 text-sm text-wp-red">Couldn’t load activity. Try refreshing.</p>
        ) : days.length === 0 && !activity.isLoading ? (
          <p className="mt-6 text-sm text-wp-slate">No days in range.</p>
        ) : (
          <div className="mt-6">
            <div
              className="flex h-56 items-end gap-2 border-b border-wp-stone px-1"
              role="img"
              aria-label={`Bar chart of ${total} updates across ${days.length} days`}
            >
              {days.map((d) => {
                const heightPct = d.count === 0 ? 0 : Math.max(4, (d.count / maxCount) * 100);
                const label = format(parseISO(d.date), "EEE M/d");
                return (
                  <div
                    key={d.date}
                    className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                  >
                    <span className="text-[11px] font-medium tabular-nums text-wp-ink">
                      {d.count}
                    </span>
                    <div
                      className="w-full max-w-[3rem] rounded-t-md bg-wp-red/85 transition-[height]"
                      style={{ height: `${heightPct}%` }}
                      title={`${label}: ${d.count}`}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2 px-1">
              {days.map((d) => (
                <div
                  key={`${d.date}-lbl`}
                  className="min-w-0 flex-1 text-center text-[10px] leading-tight text-wp-slate"
                >
                  {format(parseISO(d.date), "EEE")}
                  <br />
                  {format(parseISO(d.date), "M/d")}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ActivityByUserChart() {
  const [from, setFrom] = useState(() => daysAgoKey(6));
  const [to, setTo] = useState(() => todayKey());

  const rangeError = from && to && from > to
    ? "Start date must be on or before end date."
    : null;

  const activity = useActivityByUser({
    from,
    to,
    enabled: !rangeError && !!from && !!to,
  });

  const users = activity.data?.users ?? [];
  const total = activity.data?.total ?? 0;
  const maxCount = Math.max(1, ...users.map((u) => u.count));

  return (
    <div className="space-y-4">
      <DateRangeFilters
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
        onResetLast7={() => {
          setFrom(daysAgoKey(6));
          setTo(todayKey());
        }}
        rangeError={rangeError}
      />

      <section className="card-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-wp-ink">Updates per user</h2>
          <p className="text-xs text-wp-slate">
            {activity.isLoading
              ? "Loading…"
              : `${total} event${total === 1 ? "" : "s"} · ${
                  activity.data?.timezone ?? "local"
                }`}
          </p>
        </div>

        {activity.isError ? (
          <p className="mt-6 text-sm text-wp-red">Couldn’t load activity. Try refreshing.</p>
        ) : users.length === 0 && !activity.isLoading ? (
          <p className="mt-6 text-sm text-wp-slate">No activity in range.</p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <div
              className="flex h-56 min-w-full items-end gap-2 border-b border-wp-stone px-1"
              style={{ minWidth: `${Math.max(users.length, 1) * 3.25}rem` }}
              role="img"
              aria-label={`Bar chart of ${total} updates across ${users.length} users`}
            >
              {users.map((u) => {
                const heightPct = u.count === 0 ? 0 : Math.max(4, (u.count / maxCount) * 100);
                const key = u.user_id ?? `unknown-${u.user_name}`;
                return (
                  <div
                    key={key}
                    className="flex w-12 shrink-0 flex-col items-center justify-end gap-1"
                  >
                    <span className="text-[11px] font-medium tabular-nums text-wp-ink">
                      {u.count}
                    </span>
                    <div
                      className="w-full max-w-[2.5rem] rounded-t-md bg-wp-red/85 transition-[height]"
                      style={{ height: `${heightPct}%` }}
                      title={`${u.user_name}: ${u.count}`}
                    />
                  </div>
                );
              })}
            </div>
            <div
              className="mt-2 flex gap-2 px-1"
              style={{ minWidth: `${Math.max(users.length, 1) * 3.25}rem` }}
            >
              {users.map((u) => {
                const key = `${u.user_id ?? "unknown"}-lbl`;
                return (
                  <div
                    key={key}
                    className="w-12 shrink-0 truncate text-center text-[10px] leading-tight text-wp-slate"
                    title={u.user_name}
                  >
                    {u.user_name}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Renders the assigned homepage activity chart (embedded / code).
 * Mount on HomeView column B.
 */
export function AbHomeActivityChart() {
  const codeKey = useHomeActivityCodeVariant();

  if (codeKey === HOME_ACTIVITY_BY_USER_KEY) {
    return <ActivityByUserChart />;
  }

  return <ActivityByDayChart />;
}
