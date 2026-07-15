# Email notifications

Waypoint sends transactional email through [Resend](https://resend.com)
because Fly.io blocks outbound SMTP.

## Current state

- **Sender**: `Waypoint <onboarding@resend.dev>` — Resend's shared
  verified domain. Works instantly, but recipients see "via
  resend.dev" in most inbox clients.
- **What's sent today**: two weekly emails per tenant.
  1. **Reminder** — one email per opted-in owner every Thursday
     at 10:00 in `REPORTING_TIMEZONE`, listing the status updates
     they owe that week. Only fires when they actually have
     pending items — the query mirrors the "Pending" list in the
     app. Timed as a day-of-week nudge before the Friday due-date.
  2. **Digest** — one email per admin-picked recipient every
     Friday at 17:00 in `REPORTING_TIMEZONE`, containing all of
     that week's completed status updates grouped by swim lane.
     Recipients are managed under Admin → Notifications (a mix
     of registered users and ad-hoc email addresses). Groups
     with no completed updates or no recipients skip silently
     so the digest never sends an empty "nothing to report".

## Fly.io secrets to set

```bash
# Required to actually send. Without it the job logs and skips.
fly secrets set RESEND_API_KEY=re_...

# Optional overrides.
fly secrets set EMAIL_FROM_ADDRESS="Waypoint <no-reply@your-domain>"
fly secrets set PUBLIC_APP_URL="https://waypoint-qmh6xa.fly.dev"
fly secrets set EMAIL_UNSUBSCRIBE_SECRET="$(openssl rand -hex 32)"
```

`PUBLIC_APP_URL` shows up in email bodies as the "Open Waypoint"
link target and as the base of the one-click unsubscribe URL, so
set it before wide rollout.

`EMAIL_UNSUBSCRIBE_SECRET` signs the HMAC in unsubscribe tokens.
Rotating it invalidates every outstanding unsubscribe link, which
is intentional as an emergency kill switch. If unset the code
falls back to `SUPER_ADMIN_PASSWORD` so the feature keeps working
in single-tenant self-hosts that never set a dedicated secret.

## Upgrading the sender domain (recommended)

Sending as `@resend.dev` works but Gmail and Outlook display it as
a third-party sender, which erodes trust. When you're ready:

1. Buy or pick a domain you control (e.g. `waypoint.example.com`).
2. In the Resend dashboard, add the domain and copy the SPF, DKIM,
   and DMARC records they show.
3. Add those DNS records at your registrar.
4. Wait for verification (usually minutes).
5. Update the Fly secret:
   `fly secrets set EMAIL_FROM_ADDRESS="Waypoint <no-reply@waypoint.example.com>"`
6. Trigger a manual send to confirm the new sender renders
   correctly in Gmail / Outlook / Apple Mail.

## Local development

Leave `RESEND_API_KEY` unset. `sendEmail` short-circuits with a
`console.warn` and returns a synthetic message id, so the job's
downstream code (log insert, per-owner aggregation) still runs.

To trigger a manual pass without waiting for Thursday:

```bash
cd backend
npx tsx scripts/smoke_reminders.ts dry-run
```

`dry-run` prints the results and skips both the provider call and
the log insert.

## Observability

Every send inserts a row in `notification_log`:

```sql
SELECT kind, week_of, sent_at, provider_message_id
  FROM notification_log
 ORDER BY sent_at DESC
 LIMIT 20;
```

Two partial-unique indexes guarantee no double-send even if the
job runs twice or the container restarts:

  * `(kind, user_id, week_of)` for the reminder (one row per
    user per week).
  * `(kind, group_id, LOWER(recipient_email), week_of)` for the
    digest (one row per group + email combo per week — the
    lowercase email is the tie-breaker because addresses are
    case-insensitive).

Cleanup rows (for failed sends where the provider errored) drop
themselves so the next scheduled run gets a fresh shot.

## Opt-out surface

Users can toggle off via:

1. The "Email me a weekly reminder" checkbox in their
   profile dialog (top nav → click your name).
2. The "Unsubscribe" link in every email footer — HMAC-signed
   token, no login required, flips `email_reminders_enabled=false`
   on their user row and shows a confirmation page.
