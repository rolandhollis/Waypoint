/**
 * Frontend helpers for parsing + rendering inline @mention tokens.
 *
 * The token format `@[Display Name](user:UUID)` matches what the
 * backend indexes in `mentions` (see backend/src/lib/mentions.ts).
 * The idea: comments and descriptions stay plain-text columns —
 * mentions are just a token that survives copy/paste, degrades
 * gracefully when styling isn't in play, and can be diffed at write
 * time for "who was newly tagged?" without a separate offsets store.
 */
export type MentionableUser = {
  id: string;
  name: string;
  email: string;
  color: string;
};

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; userId: string; displayName: string };

// UUIDs are strict here so a hand-crafted `@[bad](user:not-a-uuid)`
// falls through as plain text rather than being rendered as a chip.
const MENTION_REGEX =
  /@\[([^\]\n\r]{1,200})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/**
 * Split a body of text into an ordered list of segments — plain
 * text and mention chips. Renderers walk the array and produce a
 * `<span>` per segment. Empty text segments are elided so consumers
 * don't have to guard for them.
 *
 * Passing text with no `@` is O(1) — we short-circuit before
 * building the RegExp instance.
 */
export function parseMentions(text: string): MentionSegment[] {
  if (!text) return [];
  if (text.indexOf("@") === -1) return [{ kind: "text", text }];

  const out: MentionSegment[] = [];
  const re = new RegExp(MENTION_REGEX.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    out.push({
      kind: "mention",
      text: match[0],
      userId: (match[2] ?? "").toLowerCase(),
      displayName: (match[1] ?? "").trim(),
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    out.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return out;
}

/**
 * Serialize a picked user into the canonical inline token. The
 * caller (MentionPicker) inserts this into the textarea at the
 * caret; the display name is trimmed to keep the token compact and
 * predictable.
 */
export function formatToken(user: { id: string; name: string }): string {
  return `@[${user.name.trim()}](user:${user.id})`;
}

/**
 * State machine for "is the caret currently sitting inside a
 * potential @mention query?"
 *
 * A mention query is triggered by a `@` that:
 *   * is at the beginning of the string OR preceded by whitespace
 *     (so an email address `foo@bar` doesn't fire the picker)
 *   * is NOT followed by a full `[...](user:UUID)` — that's an
 *     already-inserted token, not a fresh query
 *
 * Returns null when the caret isn't inside a query; otherwise
 * returns `{ start, query }` where `start` is the offset of the `@`
 * and `query` is everything between `@` and the caret (used to
 * filter the roster).
 */
export type MentionQueryContext = {
  /** Offset of the `@` character that opens this query. */
  start: number;
  /** Text between `@` and the caret (may be empty right after `@`). */
  query: string;
};

export function findActiveMentionQuery(
  text: string,
  caret: number,
): MentionQueryContext | null {
  // Scan backwards from the caret to find the most recent `@` that
  // could open a query. Whitespace or a closing token character
  // between here and there means no active query.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text.charAt(i);
    if (ch === "@") {
      // Must be at start-of-string or after whitespace to count
      // — prevents `foo@bar` (email) from triggering the picker.
      const prev = i === 0 ? "" : text.charAt(i - 1);
      if (i !== 0 && !/\s/.test(prev)) return null;
      const query = text.slice(i + 1, caret);
      // A completed token has `](user:UUID)` right after the `@[...`
      // sequence — bail so we don't relaunch the picker over an
      // already-inserted mention while the caret rests inside it.
      if (query.startsWith("[")) return null;
      // Query can't span newlines — a hard break ends the search
      // window. Same for whitespace-run beyond a small budget: a PM
      // who types "@abc def" is done with the mention and is now
      // writing the next word.
      if (/[\r\n]/.test(query)) return null;
      return { start: i, query };
    }
    // Any newline or a run of whitespace before finding `@` means
    // we've walked out of the query window — stop.
    if (ch === "\n" || ch === "\r") return null;
  }
  return null;
}

/**
 * Case-insensitive substring match against name OR email. Empty
 * query matches everything so pressing `@` shows the full roster.
 */
export function filterMentionCandidates<U extends { name: string; email: string }>(
  candidates: readonly U[],
  query: string,
): U[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...candidates];
  return candidates.filter(
    (u) =>
      u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
  );
}

/**
 * Replace the range from an `@` trigger through the current caret
 * with the token for the picked user, followed by one space so the
 * user can keep typing. Returns the new text plus the caret
 * position the textarea should sit at afterward.
 */
export function insertMentionAt(args: {
  text: string;
  triggerStart: number;
  caret: number;
  user: { id: string; name: string };
}): { text: string; caret: number } {
  const { text, triggerStart, caret, user } = args;
  const token = formatToken(user);
  const before = text.slice(0, triggerStart);
  const after = text.slice(caret);
  // Append a space so the next character the user types isn't glued
  // to the token — avoids `@Alicehello`. If the next char is
  // already whitespace we skip inserting a duplicate.
  const insert = /^\s/.test(after) ? token : `${token} `;
  const nextText = `${before}${insert}${after}`;
  return { text: nextText, caret: before.length + insert.length };
}
