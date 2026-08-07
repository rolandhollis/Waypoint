import cron from "node-cron";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { deriveConstants, weeklyStatusScheduleForConstants } from "../lib/groupConstants.js";
import { dueAtForWeek, weekOfMonday } from "../lib/time.js";
import {
  isWeeklyStatusScheduleSlot,
  resolveWeeklyStatusSchedule,
} from "../lib/weeklyStatusSchedule.js";
import { runStatusReportReminders } from "../notifications/statusReminders.js";
import { runStatusReportDigest } from "../notifications/statusDigest.js";

/**
 * Weekly rollover — Monday 00:05 in reporting timezone.
 * We don't need to materialize rows in advance (an update row is
 * created lazily on first save), but this job is the hook to backfill
 * or archive any bookkeeping in the future.
 */
async function rolloverJob() {
  const week = weekOfMonday(new Date());
  const iso = week.toISOString().slice(0, 10);
  const schedule = resolveWeeklyStatusSchedule();
  console.log(
    `[cron] weekly rollover — new week_of=${iso}, due_at=${dueAtForWeek(week, schedule).toISOString()}`,
  );
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
  console.log(
    `[cron] overdue check — ${rows[0]?.n ?? 0} update rows still incomplete for week ${week.toISOString().slice(0, 10)}`,
  );
}

/**
 * Per-minute tick: for each workspace, check whether its configured
 * reminder or digest slot matches the current local minute and fire
 * scoped sends. Schedule values live in `groups.constants` (Admin →
 * Notifications → Weekly status schedule).
 */
async function tickWeeklyStatusJobs() {
  const now = new Date();
  const { rows } = await pool.query<{ id: string; constants: unknown }>(
    `SELECT id, constants FROM groups`,
  );
  const reminderGroupIds: string[] = [];
  const digestGroupIds: string[] = [];
  for (const row of rows) {
    const schedule = weeklyStatusScheduleForConstants(deriveConstants(row.constants));
    if (isWeeklyStatusScheduleSlot(now, schedule, "reminder")) reminderGroupIds.push(row.id);
    if (isWeeklyStatusScheduleSlot(now, schedule, "digest")) digestGroupIds.push(row.id);
  }
  if (reminderGroupIds.length) {
    try {
      await runStatusReportReminders({ scopeGroupIds: reminderGroupIds });
    } catch (err) {
      console.error("[cron] status reminder job failed:", err);
    }
  }
  if (digestGroupIds.length) {
    try {
      await runStatusReportDigest({ scopeGroupIds: digestGroupIds });
    } catch (err) {
      console.error("[cron] status digest job failed:", err);
    }
  }
}

export function startCron() {
  const tz = config.reportingTimezone;
  cron.schedule("5 0 * * 1", () => rolloverJob().catch(console.error), { timezone: tz });
  cron.schedule("5 0 * * 5", () => overdueJob().catch(console.error), { timezone: tz });
  cron.schedule("* * * * *", () => tickWeeklyStatusJobs().catch(console.error));
  console.log(`[cron] scheduled weekly jobs in ${tz}; status emails use per-group schedule`);
}
