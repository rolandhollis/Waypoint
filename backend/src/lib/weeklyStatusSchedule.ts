import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { config } from "../config.js";
import { weekOfMonday } from "./time.js";

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type WeeklyStatusSchedule = {
  timezone: string;
  due_day: number;
  /** Local time in `timezone`, 24h `HH:mm`. */
  due_time: string;
  reminder_day: number;
  reminder_time: string;
  digest_day: number;
  digest_time: string;
};

export type WeeklyStatusScheduleInput = {
  timezone?: string | null;
  due_day?: number | null;
  due_time?: string | null;
  reminder_day?: number | null;
  reminder_time?: string | null;
  digest_day?: number | null;
  digest_time?: string | null;
};

export const DEFAULT_WEEKLY_STATUS_SCHEDULE: WeeklyStatusSchedule = {
  timezone: config.reportingTimezone,
  due_day: 4,
  due_time: "23:59",
  reminder_day: 4,
  reminder_time: "10:00",
  digest_day: 5,
  digest_time: "17:00",
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateTimezone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz.trim()) return null;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function validateDow(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 7) return null;
  return n;
}

function validateTime(t: unknown): string | null {
  if (typeof t !== "string" || !TIME_RE.test(t)) return null;
  return t;
}

/** Merge stored overrides with deployment defaults. */
export function resolveWeeklyStatusSchedule(
  input?: WeeklyStatusScheduleInput | null,
): WeeklyStatusSchedule {
  const d = DEFAULT_WEEKLY_STATUS_SCHEDULE;
  if (!input) return { ...d };
  return {
    timezone: validateTimezone(input.timezone) ?? d.timezone,
    due_day: validateDow(input.due_day) ?? d.due_day,
    due_time: validateTime(input.due_time) ?? d.due_time,
    reminder_day: validateDow(input.reminder_day) ?? d.reminder_day,
    reminder_time: validateTime(input.reminder_time) ?? d.reminder_time,
    digest_day: validateDow(input.digest_day) ?? d.digest_day,
    digest_time: validateTime(input.digest_time) ?? d.digest_time,
  };
}

/**
 * Due instant for a reporting week. `weekOf` must be the Monday anchor
 * from `weekOfMonday` in the same timezone as the schedule.
 */
export function dueAtForWeekFromSchedule(
  weekOf: Date,
  schedule: WeeklyStatusSchedule,
): Date {
  const offset = schedule.due_day - 1;
  const dayStr = formatInTimeZone(addDays(weekOf, offset), schedule.timezone, "yyyy-MM-dd");
  const [hh, mm] = schedule.due_time.split(":").map(Number);
  const sec = schedule.due_time === "23:59" ? 59 : 0;
  const pad = (n: number) => String(n).padStart(2, "0");
  return fromZonedTime(
    `${dayStr}T${pad(hh!)}:${pad(mm!)}:${pad(sec)}`,
    schedule.timezone,
  );
}

export type WeeklyStatusScheduleSlot = "reminder" | "digest";

/** True when `now` falls on the configured local day + minute for a slot. */
export function isWeeklyStatusScheduleSlot(
  now: Date,
  schedule: WeeklyStatusSchedule,
  slot: WeeklyStatusScheduleSlot,
): boolean {
  const tz = schedule.timezone;
  const dow = Number(formatInTimeZone(now, tz, "i"));
  const hm = formatInTimeZone(now, tz, "HH:mm");
  const day = slot === "reminder" ? schedule.reminder_day : schedule.digest_day;
  const time = slot === "reminder" ? schedule.reminder_time : schedule.digest_time;
  return dow === day && hm === time;
}

export function weekOfMondayForSchedule(now: Date, schedule: WeeklyStatusSchedule): Date {
  return weekOfMonday(now, schedule.timezone);
}
