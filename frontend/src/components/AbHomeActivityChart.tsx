import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import {
  useActivityByDay,
  useActivityByUser,
  useMentionableUsers,
} from "../lib/queries";
import {
  homeDaysAgoKey,
  homeTodayKey,
  HomeDateRangeFilters,
} from "./HomeDateRangeFilters";

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

/** Plot area for bars (px). Avoid % height — it collapses in flex columns. */
const BAR_MAX_PX = 180;

function useHomeActivityCodeVariant(): string {
  const ab = useAbSdk();
  void ab.previewRevision;

  if (!isAbSdkConfigured() || !ab.ready || ab.error) {
    return HOME_ACTIVITY_BY_DAY_KEY;
  }

  // When the container is gated off, keep the default chart (not blank).
  if (!ab.isContainerEnabled(HOME_ACTIVITY_CHART_CONTAINER)) {
    return HOME_ACTIVITY_BY_DAY_KEY;
  }

  const assignment = ab.getAssignmentByContainer(HOME_ACTIVITY_CHART_CONTAINER);
  if (!assignment || assignment.contentSource !== "code") {
    return HOME_ACTIVITY_BY_DAY_KEY;
  }

  return assignment.codeVariantKey ?? HOME_ACTIVITY_BY_DAY_KEY;
}

function ActivityByDayChart({ title }: { title: string }) {
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState(() => homeDaysAgoKey(6));
  const [to, setTo] = useState(() => homeTodayKey());

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
      <HomeDateRangeFilters
        from={from}
        to={to}
        onFrom={setFrom}
        onTo={setTo}
        onResetLast7={() => {
          setFrom(homeDaysAgoKey(6));
          setTo(homeTodayKey());
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
          <h2 className="text-base font-semibold text-wp-ink">{title}</h2>
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
                // Pixel heights — % height collapses inside flex column wrappers.
                const heightPx =
                  d.count === 0 ? 0 : Math.max(8, Math.round((d.count / maxCount) * BAR_MAX_PX));
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
                      style={{ height: `${heightPx}px` }}
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

function ActivityByUserChart({
  title,
  loadingText = "Loading…",
  errorText = "Couldn’t load activity. Try refreshing.",
  emptyText = "No activity in range.",
}: {
  title: string;
  loadingText?: string;
  errorText?: string;
  emptyText?: string;
}) {
  const [from, setFrom] = useState(() => homeDaysAgoKey(6));
  const [to, setTo] = useState(() => homeTodayKey());

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
    <section className="card-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-wp-ink" data-jiff-label="updates_per_user_title">
          {title}
        </h2>
        <p className="text-xs text-wp-slate">
          {activity.isLoading
            ? loadingText
            : `${total} event${total === 1 ? "" : "s"} · ${
                activity.data?.timezone ?? "local"
              }`}
        </p>
      </div>

      <div className="mt-4">
        <HomeDateRangeFilters
          embedded
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
          onResetLast7={() => {
            setFrom(homeDaysAgoKey(6));
            setTo(homeTodayKey());
          }}
          rangeError={rangeError}
        />
      </div>

      {activity.isError ? (
        <p className="mt-6 text-sm text-wp-red" data-jiff-label="updates_per_user_error_text">
          {errorText}
        </p>
      ) : users.length === 0 && !activity.isLoading ? (
        <p className="mt-6 text-sm text-wp-slate" data-jiff-label="updates_per_user_empty_text">
          {emptyText}
        </p>
      ) : (
        <div className="mt-6">
          <div
            className="flex h-56 items-end gap-2 border-b border-wp-stone px-1"
            role="img"
            aria-label={`Bar chart of ${total} updates across ${users.length} users`}
          >
            {users.map((u) => {
              const heightPx =
                u.count === 0 ? 0 : Math.max(8, Math.round((u.count / maxCount) * BAR_MAX_PX));
              const key = u.user_id ?? `unknown-${u.user_name}`;
              return (
                <div
                  key={key}
                  className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                >
                  <span className="text-[11px] font-medium tabular-nums text-wp-ink">
                    {u.count}
                  </span>
                  <div
                    className="w-full rounded-t-md bg-wp-red/85 transition-[height]"
                    style={{ height: `${heightPx}px` }}
                    title={`${u.user_name}: ${u.count}`}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2 px-1">
            {users.map((u) => {
              const key = `${u.user_id ?? "unknown"}-lbl`;
              return (
                <div
                  key={key}
                  className="min-w-0 flex-1 truncate text-center text-[10px] leading-tight text-wp-slate"
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
  );
}

/** Standalone chart for layout block `brand.updates_per_user`. */
export { ActivityByUserChart };

/**
 * Renders the assigned homepage activity chart (embedded / code).
 * Mount on HomeView column B.
 */
export function AbHomeActivityChart() {
  return <AbHomeActivityChartSlot />;
}

export function AbHomeActivityChartSlot({
  dayTitle = "Updates per day",
  userTitle = "Updates per user",
}: {
  dayTitle?: string;
  userTitle?: string;
}) {
  const codeKey = useHomeActivityCodeVariant();

  if (codeKey === HOME_ACTIVITY_BY_USER_KEY) {
    return <ActivityByUserChart title={userTitle} />;
  }

  return <ActivityByDayChart title={dayTitle} />;
}
