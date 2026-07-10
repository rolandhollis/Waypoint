import { config } from "../config.js";
import { query } from "../db/pool.js";
import type { UserRow } from "../types.js";
import { hashPassword, validatePassword, formatPasswordErrors } from "./password.js";

/**
 * Idempotent super-admin bootstrap. Runs on server start when
 * AUTH_MODE=password. Two invariants it always tries to maintain:
 *
 *   1. Password-mode credentials work — the user exists, has an
 *      admin-flavored role, and knows the env password iff the
 *      admin never rotated it locally.
 *   2. Multi-tenant super-user access — is_super_user=true and
 *      admin membership in every group. This is re-applied on
 *      every boot so a botched admin change can be recovered
 *      simply by restarting the app.
 *
 * The one thing we deliberately never touch is a password that's
 * already been rotated. Env vars are a first-boot / recovery
 * mechanism, not a source of truth.
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
  let user = existingRows[0];

  if (!user) {
    const hash = await hashPassword(password);
    const { rows } = await query<UserRow>(
      `INSERT INTO users (email, name, role, color, capacity, password_hash, password_updated_at, is_super_user)
       VALUES ($1, $2, 'admin', '#DC2626', 3, $3, NOW(), TRUE)
       RETURNING *`,
      [email, name, hash],
    );
    user = rows[0]!;
    console.log(`[auth] bootstrapped super-admin ${email}`);
  } else if (!user.password_hash) {
    const hash = await hashPassword(password);
    const { rows } = await query<UserRow>(
      `UPDATE users
          SET password_hash = $1,
              password_updated_at = NOW(),
              role = 'admin',
              is_super_user = TRUE,
              updated_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [hash, user.id],
    );
    user = rows[0]!;
    console.log(`[auth] set initial password + super-admin flag on existing user ${email}`);
  } else {
    // Password already set — leave it alone, but re-assert the
    // super-user flag in case someone unset it via a direct DB
    // poke or a future admin UI accidentally allows it.
    if (!user.is_super_user) {
      const { rows } = await query<UserRow>(
        `UPDATE users SET is_super_user = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [user.id],
      );
      user = rows[0]!;
      console.log(`[auth] re-asserted super-user flag on ${email}`);
    } else {
      console.log(`[auth] super-admin ${email} already provisioned; leaving password unchanged`);
    }
  }

  await ensureSuperUserMemberships(user.id);
}

/**
 * Idempotently grant the super-user admin membership in every
 * existing group, and default their `current_group_id` if they
 * don't have one yet. New groups created after boot get the
 * membership added inside the POST /groups handler.
 */
async function ensureSuperUserMemberships(userId: string): Promise<void> {
  await query(
    `INSERT INTO user_groups (user_id, group_id, role)
     SELECT $1, g.id, 'admin' FROM groups g
     ON CONFLICT (user_id, group_id) DO NOTHING`,
    [userId],
  );
  // Default current group if the row was created before migration
  // 017 or somehow got NULLed out.
  await query(
    `UPDATE users
        SET current_group_id = (
              SELECT group_id FROM user_groups
                WHERE user_id = $1
                ORDER BY created_at ASC
                LIMIT 1
            )
      WHERE id = $1
        AND current_group_id IS NULL`,
    [userId],
  );
}
