import { createHash, randomBytes } from "node:crypto";
import { query } from "../db/pool.js";

export type ApiTokenRow = {
  id: string;
  user_id: string;
  group_id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

/** Public list shape — never includes the hash or plaintext. */
export type ApiTokenPublic = {
  id: string;
  group_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
};

const TOKEN_BYTES = 32;

export function hashApiToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Mint a new token. Format: `wp_<url-safe random>`. Prefix is the
 * first 12 characters for the "ends in …" UI.
 */
export function mintApiTokenPlaintext(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const plaintext = `wp_${secret}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: hashApiToken(plaintext),
  };
}

export function toPublicToken(row: ApiTokenRow): ApiTokenPublic {
  return {
    id: row.id,
    group_id: row.group_id,
    name: row.name,
    token_prefix: row.token_prefix,
    scopes: row.scopes,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

/**
 * Resolve a bearer / x-api-key credential to an active token row.
 * Returns null when the credential is missing, malformed, revoked,
 * or expired. Touches last_used_at asynchronously on hit.
 */
export async function findActiveApiToken(
  plaintext: string,
): Promise<ApiTokenRow | null> {
  if (!plaintext.startsWith("wp_") || plaintext.length < 20) return null;
  const hash = hashApiToken(plaintext);
  const { rows } = await query<ApiTokenRow>(
    `SELECT *
       FROM api_tokens
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  // Fire-and-forget — don't slow the request path.
  query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(
    (err) => console.error("api_tokens last_used_at touch failed", err),
  );
  return row;
}

export async function listApiTokensForUser(userId: string): Promise<ApiTokenPublic[]> {
  const { rows } = await query<ApiTokenRow>(
    `SELECT *
       FROM api_tokens
      WHERE user_id = $1
        AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(toPublicToken);
}

export async function createApiToken(input: {
  userId: string;
  groupId: string;
  name: string;
  expiresAt?: string | null;
}): Promise<{ token: ApiTokenPublic; plaintext: string }> {
  const minted = mintApiTokenPlaintext();
  const { rows } = await query<ApiTokenRow>(
    `INSERT INTO api_tokens (user_id, group_id, name, token_prefix, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.userId,
      input.groupId,
      input.name.trim(),
      minted.prefix,
      minted.hash,
      input.expiresAt ?? null,
    ],
  );
  return { token: toPublicToken(rows[0]!), plaintext: minted.plaintext };
}

export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE api_tokens
        SET revoked_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND revoked_at IS NULL`,
    [tokenId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Extract wp_* credential from Authorization Bearer or X-Api-Key. */
export function extractApiTokenFromRequest(headers: {
  authorization?: string | undefined;
  "x-api-key"?: string | undefined;
}): string | null {
  const key = headers["x-api-key"]?.trim();
  if (key) return key;
  const authz = headers.authorization ?? "";
  if (authz.startsWith("Bearer ")) {
    const token = authz.slice(7).trim();
    if (token.startsWith("wp_")) return token;
  }
  return null;
}
