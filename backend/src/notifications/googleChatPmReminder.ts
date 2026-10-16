import { config } from "../config.js";
import { query } from "../db/pool.js";
import {
  deriveConstants,
  loadGroupWeeklyStatusSchedules,
  type GroupScheduleScope,
} from "../lib/groupConstants.js";
import { weekOfMondayForSchedule } from "../lib/weeklyStatusSchedule.js";
import { postGoogleChatWebhook } from "./googleChat.js";

const KIND = "google_chat_pm_reminder";

export type GoogleChatPmReminderResult = {
  weekOf: string;
  dryRun: boolean;
  groups: number;
  sent: number;
  skippedNoWebhook: number;
  skippedNoPms: number;
  errors: number;
};

function webhookForGroup(constantsRaw: unknown): string {
  const derived = deriveConstants(constantsRaw);
  const fromGroup = derived.google_chat_webhook_url?.trim() ?? "";
  if (fromGroup) return fromGroup;
  return (config.googleChatWebhookUrl ?? "").trim();
}

function buildMessage(opts: {
  groupName: string;
  pmNames: string[];
  appUrl: string;
}): string {
  const base = opts.appUrl.replace(/\/$/, "");
  const lines = [
    `⏰ *Weekly PM reminder* — ${opts.groupName}`,
    ``,
    `Please complete your *status reports* and *roadmap updates* today.`,
  ];
  if (opts.pmNames.length > 0) {
    lines.push(``, `Product managers: ${opts.pmNames.join(", ")}`);
  }
  lines.push(
    ``,
    `• Status report: ${base}/status-report`,
    `• Roadmap: ${base}/roadmap`,
  );
  return lines.join("\n");
}

/**
 * Post a Google Chat space message reminding product managers to
 * finish status reports + roadmap updates. Scoped per tenant; skips
 * groups with no webhook configured.
 */
export async function runGoogleChatPmReminder(opts: {
  dryRun?: boolean;
  scopeGroupId?: string;
  scopeGroupIds?: string[];
  /** When true, send even if a log row already exists for this week. */
  force?: boolean;
} = {}): Promise<GoogleChatPmReminderResult> {
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  const scope: GroupScheduleScope | undefined = opts.scopeGroupId
    ? { groupId: opts.scopeGroupId }
    : opts.scopeGroupIds?.length
      ? { groupIds: opts.scopeGroupIds }
      : undefined;

  const now = new Date();
  const schedules = await loadGroupWeeklyStatusSchedules(scope);

  const { rows: groups } = await query<{ id: string; name: string; constants: unknown }>(
    scope?.groupId
      ? `SELECT id, name, constants FROM groups WHERE id = $1`
      : scope?.groupIds?.length
        ? `SELECT id, name, constants FROM groups WHERE id = ANY($1::uuid[])`
        : `SELECT id, name, constants FROM groups`,
    scope?.groupId ? [scope.groupId] : scope?.groupIds?.length ? [scope.groupIds] : [],
  );

  let sent = 0;
  let skippedNoWebhook = 0;
  let skippedNoPms = 0;
  let errors = 0;
  let weekOfOut = "";

  for (const g of groups) {
    const schedule = schedules.get(g.id);
    if (!schedule) continue;
    const week = weekOfMondayForSchedule(now, schedule);
    const weekIso = week.toISOString().slice(0, 10);
    weekOfOut = weekIso;

    const webhook = webhookForGroup(g.constants);
    if (!webhook) {
      skippedNoWebhook += 1;
      console.log(`[google-chat-pm] skip group=${g.id} — no webhook URL`);
      continue;
    }

    const { rows: pms } = await query<{ name: string }>(
      `SELECT u.name
         FROM users u
         JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $1
        WHERE ug.is_product_manager = TRUE
        ORDER BY u.name ASC`,
      [g.id],
    );
    if (!pms.length) skippedNoPms += 1;

    if (!dryRun && !force) {
      const { rows: existing } = await query<{ id: string }>(
        `SELECT id FROM notification_log
          WHERE kind = $1 AND group_id = $2 AND week_of = $3::date
          LIMIT 1`,
        [KIND, g.id, weekIso],
      );
      if (existing[0]) {
        console.log(`[google-chat-pm] skip group=${g.id} week=${weekIso} — already sent`);
        continue;
      }
    }

    const text = buildMessage({
      groupName: g.name,
      pmNames: pms.map((p) => p.name),
      appUrl: config.publicAppUrl,
    });

    try {
      if (!dryRun) {
        await query(
          `DELETE FROM notification_log
            WHERE kind = $1 AND group_id = $2 AND week_of = $3::date`,
          [KIND, g.id, weekIso],
        );
        await query(
          `INSERT INTO notification_log (kind, group_id, recipient_email, week_of)
           VALUES ($1, $2, $3, $4::date)`,
          [KIND, g.id, "google-chat", weekIso],
        );
      }

      const result = await postGoogleChatWebhook({ webhookUrl: webhook, text, dryRun });

      if (!dryRun) {
        await query(
          `UPDATE notification_log
              SET provider_message_id = $1
            WHERE kind = $2 AND group_id = $3 AND week_of = $4::date`,
          [result.body.slice(0, 200) || `status=${result.status}`, KIND, g.id, weekIso],
        );
      }
      sent += 1;
      console.log(
        `[google-chat-pm] ${dryRun ? "dry-run " : ""}posted group=${g.id} pms=${pms.length}`,
      );
    } catch (err) {
      errors += 1;
      console.error(`[google-chat-pm] failed group=${g.id}:`, err);
      if (!dryRun) {
        try {
          await query(
            `DELETE FROM notification_log
              WHERE kind = $1 AND group_id = $2 AND week_of = $3::date
                AND provider_message_id IS NULL`,
            [KIND, g.id, weekIso],
          );
        } catch {
          /* ignore cleanup */
        }
      }
    }
  }

  return {
    weekOf: weekOfOut,
    dryRun,
    groups: groups.length,
    sent,
    skippedNoWebhook,
    skippedNoPms,
    errors,
  };
}
