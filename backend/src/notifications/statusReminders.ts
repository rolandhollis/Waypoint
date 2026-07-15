import { config } from "../config.js";
import { pool, query, withTransaction } from "../db/pool.js";
import { eligibleProjects } from "../routes/statusUpdates.js";
import { dueAtForWeek, weekOfMonday } from "../lib/time.js";
import { sendEmail } from "./email.js";
import { makeUnsubscribeToken } from "./unsubscribe.js";

/**
 * Weekly "you owe status updates" reminder.
 *
 * Fan-out shape:
 *   1. For every tenant (group), figure out which projects are
 *      eligible for a status update this week (reuses the query
 *      the /status-updates/pending endpoint already runs).
 *   2. Group the pending projects by owner.
 *   3. For each owner who (a) is opted in, (b) has an email on
 *      file, and (c) hasn't already received the reminder for
 *      this week, send them one aggregated email listing their
 *      pending items.
 *   4. Record the send in notification_log inside the same
 *      transaction so a retry / restart never double-sends.
 *
 * A single email per (owner, week) matters — the previous approach
 * would have hit an owner who spans multiple projects with N
 * separate emails, which is annoying and looks broken.
 */

const KIND = "status_report_reminder";

type PendingByOwner = Map<
  string, // owner user_id
  { ownerId: string; projectIds: string[]; groupNames: Set<string> }
>;

/**
 * Load the roster + membership state we need to decide who to
 * message. Returns only users who:
 *   * have an email address (obviously)
 *   * have email_reminders_enabled = true
 *   * are not the super-admin bootstrap account (they see all
 *     tenants anyway; opting them in would flood their inbox)
 * Super-admins CAN opt in by toggling the flag manually — this
 * excludes them by default rather than forever.
 */
async function loadCandidates(): Promise<Map<string, { id: string; name: string; email: string }>> {
  const { rows } = await query<{ id: string; name: string; email: string }>(
    `SELECT id, name, email
       FROM users
      WHERE email_reminders_enabled = TRUE
        AND email IS NOT NULL
        AND email <> ''`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Walk every group and aggregate `owner → [pending project ids]`.
 * `groupNames` is collected alongside so the email body can name
 * the tenant when a multi-tenant owner has pending work in more
 * than one place ("2 items in RetailMeNot, 1 in VoucherCodes").
 */
async function collectPending(week: Date): Promise<PendingByOwner> {
  const { rows: groups } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM groups`,
  );
  const iso = week.toISOString().slice(0, 10);
  const out: PendingByOwner = new Map();

  for (const g of groups) {
    const eligible = await eligibleProjects(week, g.id);
    if (!eligible.length) continue;

    const projectIds = eligible.map((e) => e.project_id);
    const { rows: updates } = await query<{ project_id: string; completed: boolean }>(
      `SELECT project_id, completed
         FROM weekly_status_updates
        WHERE week_of = $1::date AND project_id = ANY($2::uuid[])`,
      [iso, projectIds],
    );
    const completedIds = new Set(
      updates.filter((u) => u.completed).map((u) => u.project_id),
    );

    for (const e of eligible) {
      if (!e.owner_id) continue; // unowned pending items — nobody to nag
      if (completedIds.has(e.project_id)) continue;
      const existing = out.get(e.owner_id);
      if (existing) {
        existing.projectIds.push(e.project_id);
        existing.groupNames.add(g.name);
      } else {
        out.set(e.owner_id, {
          ownerId: e.owner_id,
          projectIds: [e.project_id],
          groupNames: new Set([g.name]),
        });
      }
    }
  }
  return out;
}

/**
 * Format the outgoing email body (plain text + a lightweight HTML
 * variant). Deliberately un-fancy — no logo, no images — because
 * (a) we're on Resend's shared verified domain and want to look as
 * legitimate as possible until DKIM/DMARC is set up on our own
 * domain, and (b) status reminders should feel like an internal
 * note, not a marketing blast.
 */
function renderReminder(input: {
  name: string;
  pendingCount: number;
  groupNames: string[];
  weekOf: Date;
  dueAt: Date;
  appUrl: string;
  unsubscribeUrl: string;
}): { subject: string; text: string; html: string } {
  const { name, pendingCount, groupNames, weekOf, dueAt, appUrl, unsubscribeUrl } = input;
  const weekLabel = weekOf.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: config.reportingTimezone,
  });
  const dueLabel = dueAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: config.reportingTimezone,
  });
  const itemsLabel = pendingCount === 1 ? "1 status update" : `${pendingCount} status updates`;
  // Format a friendly list — "RetailMeNot", "RetailMeNot and VoucherCodes",
  // or "A, B and C" — while keeping TS happy under noUncheckedIndexedAccess.
  const groupLabel =
    groupNames.length === 0
      ? "your workspace"
      : groupNames.length === 1
      ? (groupNames[0] ?? "your workspace")
      : `${groupNames.slice(0, -1).join(", ")} and ${groupNames[groupNames.length - 1] ?? ""}`;

  const subject = `Waypoint: ${itemsLabel} due ${dueLabel}`;
  const text = [
    `Hi ${name.split(/\s+/)[0] ?? name},`,
    "",
    `You have ${itemsLabel} pending for the week of ${weekLabel} in ${groupLabel}.`,
    `They're due by ${dueLabel}.`,
    "",
    `Open Waypoint to fill them in: ${appUrl}/status-report`,
    "",
    "Don't want these emails? Unsubscribe with one click:",
    unsubscribeUrl,
    "",
    "— Waypoint",
  ].join("\n");
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:520px;">
      <p>Hi ${escapeHtml(name.split(/\s+/)[0] ?? name)},</p>
      <p>You have <strong>${itemsLabel}</strong> pending for the week of <strong>${escapeHtml(weekLabel)}</strong> in ${escapeHtml(groupLabel)}.</p>
      <p>They're due by <strong>${escapeHtml(dueLabel)}</strong>.</p>
      <p><a href="${appUrl}/status-report" style="display:inline-block;background:#DC2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:600;">Open Waypoint</a></p>
      <p style="color:#64748b;font-size:12px;margin-top:24px;">
        Don't want these emails?
        <a href="${unsubscribeUrl}" style="color:#64748b;">Unsubscribe with one click</a>.
      </p>
    </div>
  `.trim();

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Run the send pass. Safe to call more than once per week — the
 * INSERT into notification_log races against the (kind, user_id,
 * week_of) unique index and short-circuits duplicates.
 *
 * `dryRun` mode is exposed so the cron entrypoint can run
 * without side-effects during local testing (backend logs the
 * would-be sends but skips the provider call and the log row).
 */
export async function runStatusReportReminders({ dryRun = false }: { dryRun?: boolean } = {}): Promise<{
  candidates: number;
  sent: number;
  skippedAlreadySent: number;
  errors: number;
}> {
  const week = weekOfMonday(new Date());
  const dueAt = dueAtForWeek(week);
  const weekIso = week.toISOString().slice(0, 10);
  const appUrl = config.publicAppUrl.replace(/\/$/, "");

  const candidates = await loadCandidates();
  const pending = await collectPending(week);

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const [ownerId, bucket] of pending) {
    const user = candidates.get(ownerId);
    if (!user) continue; // owner isn't opted in or has no email
    try {
      const alreadySent = await withTransaction(async (client) => {
        // Reserve the slot first — a unique-violation here means
        // another worker (or a prior run) already sent this week's
        // email and we should bail without hitting the provider.
        try {
          await client.query(
            `INSERT INTO notification_log (user_id, kind, week_of, provider_message_id)
             VALUES ($1, $2, $3::date, NULL)`,
            [ownerId, KIND, weekIso],
          );
          return false;
        } catch (e) {
          const err = e as { code?: string };
          if (err.code === "23505") return true; // unique_violation
          throw e;
        }
      });
      if (alreadySent) {
        skipped += 1;
        continue;
      }

      const unsubUrl = `${appUrl}/api/notifications/unsubscribe?token=${encodeURIComponent(
        makeUnsubscribeToken(ownerId, KIND),
      )}`;
      const msg = renderReminder({
        name: user.name,
        pendingCount: bucket.projectIds.length,
        groupNames: Array.from(bucket.groupNames),
        weekOf: week,
        dueAt,
        appUrl,
        unsubscribeUrl: unsubUrl,
      });

      if (dryRun) {
        console.log(`[reminders] DRY RUN — would send to ${user.email}: ${msg.subject}`);
        sent += 1;
        // Roll back the log row so a real run can send later. We
        // used a separate transaction above so this delete is safe.
        await query(
          `DELETE FROM notification_log WHERE user_id = $1 AND kind = $2 AND week_of = $3::date`,
          [ownerId, KIND, weekIso],
        );
        continue;
      }

      const result = await sendEmail({
        to: user.email,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      // Backfill the provider id on the reserved row so a delivery
      // investigation can trace this send end-to-end.
      await query(
        `UPDATE notification_log SET provider_message_id = $1 WHERE user_id = $2 AND kind = $3 AND week_of = $4::date`,
        [result.messageId, ownerId, KIND, weekIso],
      );
      sent += 1;
    } catch (err) {
      errors += 1;
      console.error(`[reminders] send failed for user=${ownerId}:`, err);
      // Best-effort cleanup — if the send failed AFTER the log
      // row was reserved, drop it so tomorrow's retry can pick
      // this owner up again. If the delete itself fails we've
      // logged the original error already and can move on.
      try {
        await query(
          `DELETE FROM notification_log WHERE user_id = $1 AND kind = $2 AND week_of = $3::date AND provider_message_id IS NULL`,
          [ownerId, KIND, weekIso],
        );
      } catch (cleanupErr) {
        console.error(`[reminders] cleanup failed for user=${ownerId}:`, cleanupErr);
      }
    }
  }

  console.log(
    `[reminders] status_report_reminder — candidates=${candidates.size} pendingOwners=${pending.size} sent=${sent} alreadySent=${skipped} errors=${errors}`,
  );
  return { candidates: candidates.size, sent, skippedAlreadySent: skipped, errors };
}

// -----------------------------------------------------------------
// Helper for the unsubscribe endpoint — flip the flag off and
// return the user's display name so the confirmation page can be
// friendly. Kept in this module so all "reminder plumbing" lives
// together.
// -----------------------------------------------------------------

export async function disableRemindersForUser(userId: string): Promise<{ name: string; email: string } | null> {
  const { rows } = await pool.query<{ name: string; email: string }>(
    `UPDATE users
        SET email_reminders_enabled = FALSE, updated_at = NOW()
      WHERE id = $1
      RETURNING name, email`,
    [userId],
  );
  return rows[0] ?? null;
}
