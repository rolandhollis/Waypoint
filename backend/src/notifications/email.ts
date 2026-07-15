import { Resend } from "resend";
import { config } from "../config.js";

/**
 * Transactional email client.
 *
 * Fly.io blocks outbound SMTP, so we send via the Resend HTTPS
 * API. This module owns the "shape a message and hand it to the
 * provider" step; higher-level modules (statusReminders.ts, etc.)
 * decide who, when, and what to send.
 *
 * When RESEND_API_KEY is unset the client short-circuits: the
 * message body is logged and a fake message id is returned so the
 * job's happy-path exercises the same code path in dev / preview
 * environments that don't have real credentials wired.
 */

let cached: Resend | null | undefined;
function client(): Resend | null {
  if (cached !== undefined) return cached;
  cached = config.email.resendApiKey ? new Resend(config.email.resendApiKey) : null;
  return cached;
}

export type SendResult = {
  /** Provider-assigned id, or a synthetic "dry-run-…" string when
   *  we short-circuited without a real API key. */
  messageId: string;
  /** True when the message actually went out over the wire. */
  delivered: boolean;
};

export type SendEmailInput = {
  to: string;
  subject: string;
  /** Plain text body — always included for accessibility and for
   *  clients that block HTML. */
  text: string;
  /** Optional HTML body. Recommended for anything more than a
   *  one-liner so links and layout render properly. */
  html?: string;
  /** Optional plain-text reply-to; useful when the from-address
   *  is a shared verified sender that shouldn't receive replies. */
  replyTo?: string;
  /** Optional extra headers passed straight to the provider. Used
   *  today to attach RFC 2369 / RFC 8058 List-Unsubscribe headers
   *  so Gmail lights up the built-in "Unsubscribe" button — a
   *  meaningful inbox-placement signal. */
  headers?: Record<string, string>;
};

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  const resend = client();
  if (!resend) {
    // Dev / preview: log and pretend it went out so the job's
    // downstream steps (notification_log insert) still exercise.
    console.warn(
      `[email] RESEND_API_KEY not set — pretending to send:\n  to: ${input.to}\n  subject: ${input.subject}`,
    );
    return { messageId: `dry-run-${Date.now()}`, delivered: false };
  }

  const { data, error } = await resend.emails.send({
    from: config.email.fromAddress,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
  });
  if (error) {
    // Bubble up as a plain Error so the caller's try/catch can log
    // it against the intended recipient without a special Resend
    // exception type.
    throw new Error(`resend: ${error.message ?? "unknown error"}`);
  }
  return {
    messageId: data?.id ?? "unknown",
    delivered: true,
  };
}
