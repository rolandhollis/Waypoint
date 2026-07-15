import { Router } from "express";
import { z } from "zod";
import {
  disableRemindersForUser,
  runStatusReportReminders,
} from "../notifications/statusReminders.js";
import { verifyUnsubscribeToken } from "../notifications/unsubscribe.js";
import { authenticate, groupScope, requireAdmin } from "../middleware/auth.js";

/**
 * Public-facing notification endpoints — the unsubscribe handler
 * is deliberately mounted BEFORE authenticate (a recipient
 * clicking a link from their inbox has no live session; the HMAC
 * token proves their intent). Admin-only endpoints for triggering
 * jobs on demand come further down and carry their own auth
 * middleware inline.
 */
export const notificationsRouter = Router();

notificationsRouter.get("/unsubscribe", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    res.status(400).type("html").send(page("Invalid link", "This unsubscribe link is missing its token."));
    return;
  }
  const decoded = verifyUnsubscribeToken(token);
  if (!decoded) {
    res.status(400).type("html").send(page("Invalid link", "This unsubscribe link is invalid or has expired."));
    return;
  }
  const user = await disableRemindersForUser(decoded.userId);
  if (!user) {
    // Token was valid but the user doesn't exist anymore — treat as
    // success from the recipient's perspective, no useful info to
    // leak by distinguishing this case.
    res.type("html").send(page("Unsubscribed", "You won't receive further reminder emails from Waypoint."));
    return;
  }
  res.type("html").send(
    page(
      "Unsubscribed",
      `You won't receive further reminder emails from Waypoint at <strong>${escapeHtml(user.email)}</strong>. You can re-enable them any time from your profile page inside the app.`,
    ),
  );
});

/**
 * Admin trigger for the weekly status-report reminder job. Wraps
 * `runStatusReportReminders` with two capabilities:
 *   - `dry_run: true` — no emails, no notification_log rows,
 *     returns "who would be nagged." Safe to click any number of
 *     times, useful for preview.
 *   - Real run — sends immediately. Uses the same idempotency
 *     guard as the cron path (notification_log unique index on
 *     kind + user_id + week_of), so clicking it after the Monday
 *     cron has already fired is a no-op for anyone who already
 *     got their email.
 *
 * Scope: always the caller's current group. A super-admin sitting
 * in RetailMeNot who clicks "Send" won't accidentally spam
 * VoucherCodes owners; they can switch groups and click again if
 * they intend to. Guarded by requireAdmin so tenant admins can
 * nag their own tenant.
 */
const runReminderSchema = z.object({
  dry_run: z.boolean().optional().default(false),
});

notificationsRouter.post(
  "/status-reminders/run",
  authenticate,
  groupScope,
  requireAdmin,
  async (req, res) => {
    const body = runReminderSchema.parse(req.body ?? {});
    const result = await runStatusReportReminders({
      dryRun: body.dry_run,
      scopeGroupId: req.groupId!,
    });
    res.json(result);
  },
);

function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} · Waypoint</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f8fafc; color:#0f172a; margin:0; padding:0; }
    .card { max-width: 480px; margin: 10vh auto; background:#fff; border:1px solid #e2e8f0; border-radius: 12px; padding: 32px; box-shadow: 0 10px 30px rgba(15,23,42,0.06); }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { margin: 0; color:#334155; line-height: 1.5; }
    a { color: #DC2626; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
