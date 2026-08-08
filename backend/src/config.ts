import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export type AuthMode = "mock" | "password" | "okta" | "cloudflare-access";

function parseEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>\s*$/);
  const email = match?.[1]?.trim();
  return email && email.length > 0 ? email : raw.trim();
}

/** Resend `from` header — display name is configurable; email comes from EMAIL_FROM_ADDRESS. */
function formatEmailFrom(displayName: string, rawAddress: string): string {
  return `${displayName} <${parseEmailAddress(rawAddress)}>`;
}

const defaultEmailFromAddress = process.env.EMAIL_FROM_ADDRESS ?? "onboarding@resend.dev";
const defaultEmailFromName = process.env.EMAIL_FROM_NAME ?? "RetailMeNot Product";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  databaseUrl: required("DATABASE_URL", "postgres://waypoint:waypoint@localhost:5433/waypoint"),
  authMode: (process.env.AUTH_MODE ?? "mock") as AuthMode,
  /**
   * Password mode super-admin bootstrap. If both env vars are set at
   * boot AND the user does not already exist, an admin row is
   * created. If the user exists with no password on file, the
   * password is applied; a user with an existing password is never
   * clobbered so rotated credentials survive redeploys. Idempotent
   * either way — safe to leave the secrets in Fly config forever.
   */
  superAdmin: {
    email: process.env.SUPER_ADMIN_EMAIL ?? "",
    password: process.env.SUPER_ADMIN_PASSWORD ?? "",
    name: process.env.SUPER_ADMIN_NAME ?? "Super Admin",
  },
  /** Static path served at "/" when set — used by the Docker image to
   *  serve the compiled frontend from the same origin as the API. */
  staticDir: process.env.STATIC_DIR ?? "",
  okta: {
    issuer: process.env.OKTA_ISSUER ?? "",
    audience: process.env.OKTA_AUDIENCE ?? "",
    clientId: process.env.OKTA_CLIENT_ID ?? "",
  },
  /**
   * Cloudflare Access sits in front of the app, does the OIDC dance
   * with Okta/Google/etc., and forwards a signed JWT on every request.
   * The app just needs to verify the JWT and match its `email` claim
   * to a provisioned user. See DEPLOY.md.
   */
  cloudflareAccess: {
    /** Team domain, e.g. "myteam.cloudflareaccess.com". */
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN ?? "",
    /** Application AUD tag from the Access application settings. */
    audience: process.env.CF_ACCESS_AUD ?? "",
  },
  reportingTimezone: process.env.REPORTING_TIMEZONE ?? "America/Chicago",
  /**
   * Outbound URL the app is reachable at from the recipient's
   * inbox — used to build status-report and unsubscribe links
   * in notification emails.
   */
  publicAppUrl: process.env.PUBLIC_APP_URL ?? "http://localhost:5173",
  /**
   * Resend transactional email config. When apiKey is unset the
   * notification code short-circuits and logs instead of sending —
   * so the app boots cleanly on local dev / preview envs without a
   * real key. `fromName` is the inbox display name; the SMTP address
   * comes from EMAIL_FROM_ADDRESS (or Resend's shared domain default).
   */
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    fromName: defaultEmailFromName,
    fromAddress: formatEmailFrom(defaultEmailFromName, defaultEmailFromAddress),
    /** Build a Resend `from` header, optionally overriding the display name. */
    formatFrom(displayName?: string | null): string {
      const name = displayName?.trim() || defaultEmailFromName;
      return formatEmailFrom(name, defaultEmailFromAddress);
    },
    /** Signing key for one-click unsubscribe tokens. When unset we
     *  derive one from SUPER_ADMIN_PASSWORD as a last resort so
     *  unsubscribe links keep working in single-tenant self-hosts
     *  that never set the dedicated secret. */
    unsubscribeSecret:
      process.env.EMAIL_UNSUBSCRIBE_SECRET ||
      process.env.SUPER_ADMIN_PASSWORD ||
      "waypoint-dev-unsubscribe-secret",
  },
  /**
   * Anthropic Claude config for the EZEstimates AI suggester. When
   * apiKey is unset the estimator endpoint returns a 503 with a
   * "not configured — set ANTHROPIC_API_KEY in Fly secrets" hint,
   * so the app boots cleanly on local dev / preview envs that
   * don't have a real key. The endpoint is the ONLY place that
   * calls out to Anthropic — no boot-time health check, no
   * background pings — so a missing key never delays startup.
   *
   * Model defaults to Claude Sonnet 4.5 (claude-sonnet-4-5-20250929).
   * Override via ANTHROPIC_MODEL when a newer snapshot is
   * available; the SDK validates the slug at call time.
   */
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
  },
  /** Public Kalshi Trade API — no key required for market listings. */
  kalshi: {
    apiBaseUrl:
      process.env.KALSHI_API_BASE_URL ?? "https://external-api.kalshi.com/trade-api/v2",
  },
};
