import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { config } from "../config.js";
import {
  DEFAULT_WEEKLY_STATUS_SCHEDULE,
  dueAtForWeekFromSchedule,
  type WeeklyStatusSchedule,
} from "./weeklyStatusSchedule.js";

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
 * Due instant for the given `weekOf` Monday anchor. Uses the deployment
 * default schedule unless a per-group `WeeklyStatusSchedule` is passed.
 */
export function dueAtForWeek(
  weekOf: Date,
  timeZoneOrSchedule: string | WeeklyStatusSchedule = config.reportingTimezone,
): Date {
  if (typeof timeZoneOrSchedule === "string") {
    return dueAtForWeekFromSchedule(weekOf, {
      ...DEFAULT_WEEKLY_STATUS_SCHEDULE,
      timezone: timeZoneOrSchedule,
    });
  }
  return dueAtForWeekFromSchedule(weekOf, timeZoneOrSchedule);
}
