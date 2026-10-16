import { config } from "../config.js";
import { query } from "../db/pool.js";
import type { AppConstants } from "../types.js";
import { isTabLabelKey, type TabLabels } from "./navTabs.js";
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
  if ("email_title" in bag) {
    const v = bag.email_title;
    if (v === null) out.email_title = null;
    else if (typeof v === "string") out.email_title = v;
  }
  if ("jira_brand_code" in bag) {
    const v = bag.jira_brand_code;
    if (v === null) out.jira_brand_code = null;
    else if (typeof v === "string") out.jira_brand_code = v;
  }
  if ("google_chat_webhook_url" in bag) {
    const v = bag.google_chat_webhook_url;
    if (v === null) out.google_chat_webhook_url = null;
    else if (typeof v === "string") out.google_chat_webhook_url = v;
  }
  if ("tab_labels" in bag) {
    const v = bag.tab_labels;
    if (v === null) out.tab_labels = null;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const labels: TabLabels = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!isTabLabelKey(k)) continue;
        if (val === null) labels[k] = null;
        else if (typeof val === "string") labels[k] = val;
      }
      out.tab_labels = labels;
    }
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
      if (
        "google_chat_day" in sched &&
        (sched.google_chat_day === null || typeof sched.google_chat_day === "number")
      ) {
        partial.google_chat_day = sched.google_chat_day as number | null;
      }
      if ("google_chat_time" in sched) {
        const val = sched.google_chat_time;
        if (val === null) partial.google_chat_time = null;
        else if (typeof val === "string") partial.google_chat_time = val;
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

/** Effective sender display name for outbound email from this tenant. */
export function emailTitleForConstants(constants: AppConstants): string {
  const title = constants.email_title?.trim();
  return title && title.length > 0 ? title : config.email.fromName;
}

/** Default SHOP Brand option when a workspace has not set one. */
export const DEFAULT_JIRA_BRAND_CODE = "RMN";

/** Effective Brand code for Jira sync / JPD export from this tenant. */
export function jiraBrandCodeForConstants(constants: AppConstants): string {
  const code = constants.jira_brand_code?.trim();
  return code && code.length > 0 ? code : DEFAULT_JIRA_BRAND_CODE;
}

/** Load derived constants for one, many, or all groups. */
export async function loadGroupConstants(
  scope?: GroupScheduleScope,
): Promise<Map<string, AppConstants>> {
  const { rows } = await query<{ id: string; constants: unknown }>(
    scope?.groupId
      ? `SELECT id, constants FROM groups WHERE id = $1`
      : scope?.groupIds?.length
        ? `SELECT id, constants FROM groups WHERE id = ANY($1::uuid[])`
        : `SELECT id, constants FROM groups`,
    scope?.groupId ? [scope.groupId] : scope?.groupIds?.length ? [scope.groupIds] : [],
  );
  const out = new Map<string, AppConstants>();
  for (const row of rows) {
    out.set(row.id, deriveConstants(row.constants));
  }
  return out;
}
