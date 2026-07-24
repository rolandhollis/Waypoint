/**
 * Parser + diff helpers for inline @mention tokens.
 *
 * Storage decision (see 040_mentions.sql): mentions live INLINE in
 * the parent text using the token format `@[Display Name](user:UUID)`.
 * No separate offsets column, no rich-text schema — anything already
 * in the database keeps working as-is (regex is a strict superset of
 * "no @ present at all"), and the human-readable form makes plain-
 * text renderings, copy/paste, and email digests behave sensibly even
 * when styling isn't in play.
 *
 * The routes call `parseMentions(text)` on write, `diffMentions(prev,
 * next)` to figure out which tags are freshly added (so we only email
 * once), and treat the token as opaque otherwise.
 */
export type ParsedMention = {
  user_id: string;
  display_name: string;
  /** Character offset of the leading `@` in the source text. */
  offset: number;
};

// Anchored regex used for parseMentions. The display name is
// permissive (anything but `]` / newline) so a user with parentheses
// in their name still round-trips; the user id must be UUID-shaped so
// arbitrary `@[foo](user:hacker)` payloads can't wander in from a
// hand-crafted client and cause a bogus DB insert or email send.
const MENTION_REGEX =
  /@\[([^\]\n\r]{1,200})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/**
 * Extract every @mention token from a body string, in source order.
 *
 * Returns an empty array for text that never had an `@` in it — the
 * regex is anchored and stateful (uses the `g` flag) so we scan once
 * per call. Duplicate mentions (the same user tagged twice) each get
 * their own entry — the caller usually calls `newMentionUserIds` /
 * `diffMentions` on top of this to collapse to a set of user ids.
 */
export function parseMentions(text: string): ParsedMention[] {
  if (!text || text.indexOf("@") === -1) return [];
  const out: ParsedMention[] = [];
  // Local RegExp instance so concurrent calls don't fight over the
  // shared `lastIndex` on a module-level regex object.
  const re = new RegExp(MENTION_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({
      display_name: (match[1] ?? "").trim(),
      user_id: (match[2] ?? "").toLowerCase(),
      offset: match.index,
    });
  }
  return out;
}

/** Distinct set of mentioned user ids in `text`. */
export function mentionUserIds(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of parseMentions(text)) set.add(m.user_id);
  return set;
}

/**
 * Compute the set of user ids that are NEW between two revisions of a
 * comment or description. Used by the comment PATCH and project PATCH
 * hooks so an edit that only fixes a typo, or removes a tag, doesn't
 * re-send email to everyone who was already there.
 *
 * `prevText` may be null/undefined for creates (nothing came before);
 * every mentioned user is treated as newly-added in that case.
 */
export function newlyAddedMentionIds(
  prevText: string | null | undefined,
  nextText: string,
): string[] {
  const prev = prevText ? mentionUserIds(prevText) : new Set<string>();
  const next = mentionUserIds(nextText);
  const out: string[] = [];
  for (const id of next) if (!prev.has(id)) out.push(id);
  return out;
}

/**
 * Truncate a snippet for use in an email body without cutting through
 * a mention token — a half-parsed token in an email looks broken. We
 * find the last token whose full span fits inside the cap and clip
 * just after it; if no token fits (or the text is under the cap
 * anyway), fall back to a plain character-count truncation with an
 * ellipsis. Tokens themselves are rewritten to their display name so
 * "@[Alice](user:...)" reads as "@Alice" in plain text.
 */
export function snippetForEmail(text: string, maxLength: number): string {
  const plain = renderMentionsAsPlain(text);
  if (plain.length <= maxLength) return plain;
  // Prefer breaking on a space near the cap so we don't chop a word.
  const clip = plain.slice(0, maxLength);
  const lastSpace = clip.lastIndexOf(" ");
  const cut = lastSpace > maxLength - 30 ? clip.slice(0, lastSpace) : clip;
  return `${cut.trimEnd()}\u2026`;
}

/**
 * Rewrite every `@[Name](user:UUID)` token as `@Name` for use in
 * email plain-text bodies and other renderings that don't want the
 * `(user:...)` half exposed to the reader.
 */
export function renderMentionsAsPlain(text: string): string {
  return text.replace(
    MENTION_REGEX,
    (_all, display: string) => `@${display.trim()}`,
  );
}
