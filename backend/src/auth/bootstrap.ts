import { config } from "../config.js";
import { query } from "../db/pool.js";
import type { UserRow } from "../types.js";
import { hashPassword, validatePassword, formatPasswordErrors } from "./password.js";

/**
 * Idempotent super-admin bootstrap. Runs on server start when
 * AUTH_MODE=password. Behavior matrix:
 *
 *   env vars missing           → warn and no-op (first-boot friendly)
 *   env pw fails policy        → warn and no-op (don't crash the app)
 *   user does not exist        → create with admin role + hashed pw
 *   user exists, no pw on file → set pw + promote to admin
 *   user exists, has pw        → skip (never clobber rotated creds)
 *
 * The "never clobber" rule is what makes it safe to leave the env
 * vars set forever — a rotated password survives redeploys.
 */
export async function bootstrapSuperAdmin(): Promise<void> {
  if (config.authMode !== "password") return;

  const email = config.superAdmin.email.trim();
  const password = config.superAdmin.password;
  const name = config.superAdmin.name.trim() || "Super Admin";

  if (!email || !password) {
    console.warn(
      "[auth] AUTH_MODE=password but SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set — no super-admin will be bootstrapped",
    );
    return;
  }

  const errs = validatePassword(password, email);
  if (errs.length) {
    console.warn(
      `[auth] SUPER_ADMIN_PASSWORD failed policy: ${formatPasswordErrors(errs).join("; ")} — skipping bootstrap`,
    );
    return;
  }

  const { rows: existingRows } = await query<UserRow>(
    `SELECT * FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const existing = existingRows[0];

  if (!existing) {
    const hash = await hashPassword(password);
    await query(
      `INSERT INTO users (email, name, role, color, capacity, password_hash, password_updated_at)
       VALUES ($1, $2, 'admin', '#DC2626', 3, $3, NOW())`,
      [email, name, hash],
    );
    console.log(`[auth] bootstrapped super-admin ${email}`);
    return;
  }

  if (!existing.password_hash) {
    const hash = await hashPassword(password);
    await query(
      `UPDATE users
          SET password_hash = $1,
              password_updated_at = NOW(),
              role = 'admin',
              updated_at = NOW()
        WHERE id = $2`,
      [hash, existing.id],
    );
    console.log(`[auth] set initial password + admin role on existing user ${email}`);
    return;
  }

  console.log(`[auth] super-admin ${email} already provisioned; leaving password unchanged`);
}
