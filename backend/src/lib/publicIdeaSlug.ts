import { query } from "../db/pool.js";
import { HttpError } from "../middleware/error.js";

export type PublicIdeaGroup = {
  id: string;
  name: string;
  public_slug: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Lowercase kebab: letters, digits, single hyphens. */
export const PUBLIC_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizePublicSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Resolve a workspace by public slug or UUID. Used by the public
 * idea + test-idea forms so shareable URLs stay pretty
 * (`/ideas/retailmenot`, `/test-ideas/retailmenot`) while old
 * UUID links still work.
 */
export async function resolvePublicIdeaGroup(
  slugOrId: string,
): Promise<PublicIdeaGroup> {
  const key = slugOrId.trim();
  if (!key) throw new HttpError(404, "workspace not found");

  if (UUID_RE.test(key)) {
    const { rows } = await query<PublicIdeaGroup>(
      `SELECT id, name, public_slug FROM groups WHERE id = $1`,
      [key],
    );
    if (!rows[0]) throw new HttpError(404, "workspace not found");
    return rows[0];
  }

  const slug = normalizePublicSlug(key);
  if (!PUBLIC_SLUG_RE.test(slug)) {
    throw new HttpError(404, "workspace not found");
  }
  const { rows } = await query<PublicIdeaGroup>(
    `SELECT id, name, public_slug FROM groups WHERE public_slug = $1`,
    [slug],
  );
  if (!rows[0]) throw new HttpError(404, "workspace not found");
  return rows[0];
}
