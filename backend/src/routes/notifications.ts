import { Router } from "express";
import { disableRemindersForUser } from "../notifications/statusReminders.js";
import { verifyUnsubscribeToken } from "../notifications/unsubscribe.js";

/**
 * Public-facing notification endpoints. These are the ONLY endpoints
 * mounted before the auth middleware — a recipient clicking an
 * unsubscribe link from their inbox has no live session and doesn't
 * need one (the HMAC token proves their intent).
 *
 * The unsubscribe handler serves a friendly HTML confirmation page
 * rather than raw JSON so a recipient who ends up on this URL sees a
 * sensible acknowledgement instead of `{"ok":true}`.
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
