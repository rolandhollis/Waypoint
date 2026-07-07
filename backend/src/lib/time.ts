import { addDays, startOfDay } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { config } from "../config.js";

/**
 * Return the Monday (00:00 in the reporting timezone) of the calendar week that
 * `date` falls in, as a UTC Date. This is what we store in `weekly_status_updates.week_of`.
 */
export function weekOfMonday(date: Date, timeZone: string = config.reportingTimezone): Date {
  const yyyyMmDd = formatInTimeZone(date, timeZone, "yyyy-MM-dd");
  const dowStr = formatInTimeZone(date, timeZone, "i"); // 1=Mon..7=Sun
  const dow = Number(dowStr);
  const localMidnight = fromZonedTime(`${yyyyMmDd}T00:00:00`, timeZone);
  return addDays(localMidnight, -(dow - 1));
}

/**
 * Thursday 23:59:59 in reporting timezone for the given `weekOf` (which should
 * itself be a Monday from `weekOfMonday`). Returned as a UTC Date so the
 * DB stores it correctly across DST.
 */
export function dueAtForWeek(weekOf: Date, timeZone: string = config.reportingTimezone): Date {
  const dayStr = formatInTimeZone(addDays(weekOf, 3), timeZone, "yyyy-MM-dd");
  return fromZonedTime(`${dayStr}T23:59:59`, timeZone);
}

/**
 * Thursday 08:00 in reporting timezone — the moment the reminder banner
 * should start showing for the current week.
 */
export function reminderStartForWeek(weekOf: Date, timeZone: string = config.reportingTimezone): Date {
  const dayStr = formatInTimeZone(addDays(weekOf, 3), timeZone, "yyyy-MM-dd");
  return fromZonedTime(`${dayStr}T08:00:00`, timeZone);
}

export function isoDate(d: Date): string {
  return startOfDay(d).toISOString().slice(0, 10);
}
