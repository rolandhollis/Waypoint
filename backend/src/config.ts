import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export type AuthMode = "mock" | "password" | "okta" | "cloudflare-access";

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
};
