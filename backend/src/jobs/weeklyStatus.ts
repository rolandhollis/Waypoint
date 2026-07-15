import cron from "node-cron";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { dueAtForWeek, weekOfMonday } from "../lib/time.js";
import { runStatusReportReminders } from "../notifications/statusReminders.js";

/**
 * Weekly rollover — Monday 00:05 in reporting timezone.
 * We don't need to materialize rows in advance (an update row is
 * created lazily on first save), but this job is the hook to backfill
 * or archive any bookkeeping in the future.
 */
async function rolloverJob() {
  const week = weekOfMonday(new Date());
  const iso = week.toISOString().slice(0, 10);
  console.log(`[cron] weekly rollover — new week_of=${iso}, due_at=${dueAtForWeek(week).toISOString()}`);
}

/**
 * Overdue flip — Friday 00:05 in reporting timezone.
 * Purely informational: the "who's incomplete" query already computes overdue
 * state on demand, but running this job lets us log/notify at the boundary.
 */
async function overdueJob() {
  const week = weekOfMonday(new Date());
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM weekly_status_updates
      WHERE week_of = $1::date AND completed = FALSE`,
    [week.toISOString().slice(0, 10)],
  );
  console.log(`[cron] overdue check — ${rows[0]?.n ?? 0} update rows still incomplete for week ${week.toISOString().slice(0, 10)}`);
}

/**
 * Weekly status-report reminder — Monday 9:00 in reporting timezone.
 * Chosen so owners see it right as their week starts, with plenty
 * of runway before the Friday due-date. Runs on the Fly machine's
 * always-on process; the notification_log unique index guarantees
 * we never double-send if the container restarts near the trigger.
 */
async function reminderJob() {
  try {
    await runStatusReportReminders();
  } catch (err) {
    console.error("[cron] status reminder job failed:", err);
  }
}

export function startCron() {
  const tz = config.reportingTimezone;
  cron.schedule("5 0 * * 1", () => rolloverJob().catch(console.error), { timezone: tz });
  cron.schedule("5 0 * * 5", () => overdueJob().catch(console.error), { timezone: tz });
  cron.schedule("0 9 * * 1", () => reminderJob(), { timezone: tz });
  console.log(`[cron] scheduled weekly jobs in ${tz}`);
}
