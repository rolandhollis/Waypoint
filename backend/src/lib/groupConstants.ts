import { query } from "../db/pool.js";
import type { AppConstants } from "../types.js";
import {
  resolveWeeklyStatusSchedule,
  type WeeklyStatusSchedule,
  type WeeklyStatusScheduleInput,
} from "./weeklyStatusSchedule.js";

/**
 * Normalize whatever's in `groups.constants` (JSONB, freeform) into
 * the narrow `AppConstants` surface every consumer expects.
 */
export function deriveConstants(raw: unknown): AppConstants {
  const bag =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: AppConstants = {};
  if ("app_name" in bag) {
    const v = bag.app_name;
    if (v === null) out.app_name = null;
    else if (typeof v === "string") out.app_name = v;
  }
  if ("weekly_status_schedule" in bag) {
    const v = bag.weekly_status_schedule;
    if (v === null) out.weekly_status_schedule = null;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const sched = v as Record<string, unknown>;
      const partial: WeeklyStatusScheduleInput = {};
      if ("timezone" in sched) {
        const val = sched.timezone;
        if (val === null) partial.timezone = null;
        else if (typeof val === "string") partial.timezone = val;
      }
      if ("due_day" in sched && (sched.due_day === null || typeof sched.due_day === "number")) {
        partial.due_day = sched.due_day as number | null;
      }
      if ("due_time" in sched) {
        const val = sched.due_time;
        if (val === null) partial.due_time = null;
        else if (typeof val === "string") partial.due_time = val;
      }
      if ("reminder_day" in sched && (sched.reminder_day === null || typeof sched.reminder_day === "number")) {
        partial.reminder_day = sched.reminder_day as number | null;
      }
      if ("reminder_time" in sched) {
        const val = sched.reminder_time;
        if (val === null) partial.reminder_time = null;
        else if (typeof val === "string") partial.reminder_time = val;
      }
      if ("digest_day" in sched && (sched.digest_day === null || typeof sched.digest_day === "number")) {
        partial.digest_day = sched.digest_day as number | null;
      }
      if ("digest_time" in sched) {
        const val = sched.digest_time;
        if (val === null) partial.digest_time = null;
        else if (typeof val === "string") partial.digest_time = val;
      }
      out.weekly_status_schedule = partial;
    }
  }
  out.weekly_status_schedule_effective = resolveWeeklyStatusSchedule(
    out.weekly_status_schedule ?? undefined,
  );
  return out;
}

export function weeklyStatusScheduleForConstants(
  constants: AppConstants,
): WeeklyStatusSchedule {
  return constants.weekly_status_schedule_effective ?? resolveWeeklyStatusSchedule();
}

export type GroupScheduleScope = {
  groupId?: string;
  groupIds?: string[];
};

/** Load resolved weekly-status schedules for one, many, or all groups. */
export async function loadGroupWeeklyStatusSchedules(
  scope?: GroupScheduleScope,
): Promise<Map<string, WeeklyStatusSchedule>> {
  const { rows } = await query<{ id: string; constants: unknown }>(
    scope?.groupId
      ? `SELECT id, constants FROM groups WHERE id = $1`
      : scope?.groupIds?.length
        ? `SELECT id, constants FROM groups WHERE id = ANY($1::uuid[])`
        : `SELECT id, constants FROM groups`,
    scope?.groupId ? [scope.groupId] : scope?.groupIds?.length ? [scope.groupIds] : [],
  );
  const out = new Map<string, WeeklyStatusSchedule>();
  for (const row of rows) {
    out.set(row.id, weeklyStatusScheduleForConstants(deriveConstants(row.constants)));
  }
  return out;
}

export async function loadGroupWeeklyStatusSchedule(groupId: string): Promise<WeeklyStatusSchedule> {
  const map = await loadGroupWeeklyStatusSchedules({ groupId });
  return map.get(groupId) ?? resolveWeeklyStatusSchedule();
}
