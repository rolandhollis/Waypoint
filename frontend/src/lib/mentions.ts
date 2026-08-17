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
 * ---------------------------------------------------------------------------
 * Contenteditable helpers.
 *
 * The editable `MentionTextarea` renders each mention as an inline atomic
 * `<span data-mention-user-id data-mention-display-name contenteditable="false">`
 * so browsers treat it like a native chip (caret cannot enter, Backspace/Delete
 * remove the whole span in one keystroke). These helpers convert between the
 * on-wire storage format (`@[Name](user:UUID)`) and that DOM structure while
 * preserving the parser used everywhere else in the app.
 * ---------------------------------------------------------------------------
 */

const MENTION_CHIP_CLASSNAME = "mention-chip";

/**
 * Detect a mention chip span in a contenteditable tree. Chips are the
 * only element type that carries a `data-mention-user-id` attribute.
 *
 * Returned as a plain boolean (not a `node is HTMLElement` predicate)
 * so callers whose input is already narrowed to `HTMLElement` don't get
 * false-negatively narrowed to `never` in the else branch of an
 * `if (isMentionChip(el)) { … return; }` chain.
 */
export function isMentionChip(node: Node | null | undefined): boolean {
  return (
    !!node &&
    node.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).dataset?.mentionUserId != null
  );
}

/**
 * Build the atomic chip span. Both the display name and user id are stashed
 * on `dataset.*` so serialize doesn't have to parse the visible text back
 * out — this keeps names with spaces, punctuation, unicode, or a trailing
 * period intact regardless of how the browser folded/normalized the text.
 *
 * `contenteditable="false"` is what makes the browser treat the whole span
 * as one uneditable glyph: caret can sit before/after but never enter, and
 * Backspace/Delete at the boundary remove the entire chip in a single
 * keystroke natively.
 */
export function createMentionChip(
  user: { id: string; name: string },
  doc: Document = document,
): HTMLSpanElement {
  const span = doc.createElement("span");
  span.dataset.mentionUserId = user.id;
  span.dataset.mentionDisplayName = user.name;
  span.setAttribute("contenteditable", "false");
  span.className = MENTION_CHIP_CLASSNAME;
  span.title = user.name;
  // The visible text is exactly what the read-only MentionText renderer
  // shows (`@Name`), so a chip pasted into a plain-text sink still reads
  // like a mention. The serialized token still uses `@[Name](user:UUID)`
  // — that's a separate step, not the DOM text content.
  span.textContent = `@${user.name}`;
  return span;
}

/** Reconstruct the canonical `@[Name](user:UUID)` token from a chip's dataset. */
function chipToToken(el: HTMLElement): string {
  const name = el.dataset.mentionDisplayName ?? "";
  const id = el.dataset.mentionUserId ?? "";
  return `@[${name}](user:${id})`;
}

/**
 * Walk a contenteditable subtree and emit the on-wire string:
 *   • text nodes contribute their `textContent` verbatim
 *   • `<br>` elements contribute `\n`
 *   • mention chip spans contribute their dataset-backed token
 *   • `<div>` / `<p>` block wrappers (created by browsers on Enter) act
 *     as implicit line breaks so a Chrome-inserted `<div>Line2</div>`
 *     serializes the same as `<br>Line2`.
 *
 * Everything else is a generic passthrough — we recurse into its children.
 * The result is byte-for-byte round-trippable with `deserializeIntoRoot`
 * so the controlled-input pattern stays stable.
 */
export function serializeContentEditable(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    if (isMentionChip(el)) {
      out += chipToToken(el);
      return;
    }
    if (el.tagName === "DIV" || el.tagName === "P") {
      // Browsers sometimes wrap the first line in `<div>` too — only
      // emit the implicit break when there's actual content before us
      // so we don't get a phantom leading newline.
      if (out.length > 0 && !out.endsWith("\n")) out += "\n";
      for (const c of Array.from(el.childNodes)) walk(c);
      return;
    }
    for (const c of Array.from(el.childNodes)) walk(c);
  };
  for (const c of Array.from(root.childNodes)) walk(c);
  return out;
}

/**
 * Rebuild `root`'s children from the on-wire `text`. Well-formed mention
 * tokens become chip spans; everything else lands as text nodes. Newlines
 * stay as literal `\n` characters inside those text nodes — the editor
 * uses `white-space: pre-wrap` so `\n` renders as a line break without
 * needing `<br>` sentinels, and the round-trip through `serialize` /
 * `deserialize` stays byte-stable. The `root` is cleared first so this
 * is safe to call repeatedly from the reconcile useEffect.
 */
export function deserializeIntoRoot(
  root: HTMLElement,
  text: string,
  doc: Document = root.ownerDocument ?? document,
): void {
  while (root.firstChild) root.removeChild(root.firstChild);
  if (!text) return;
  if (text.indexOf("@") === -1) {
    root.appendChild(doc.createTextNode(text));
    return;
  }
  const re = new RegExp(MENTION_REGEX.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      root.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
    }
    root.appendChild(
      createMentionChip(
        {
          id: (match[2] ?? "").toLowerCase(),
          name: (match[1] ?? "").trim(),
        },
        doc,
      ),
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    root.appendChild(doc.createTextNode(text.slice(lastIndex)));
  }
}

/**
 * Compute the serialized-string caret offset for a DOM position inside
 * `root`. Uses a Range → cloneContents pipe: clone everything from the
 * start of `root` up to (node, offset), then serialize that fragment and
 * return its length. Cloning preserves chip dataset attributes, so a
 * partially-selected chip still serializes as its full canonical token.
 *
 * If `node` isn't a descendant of `root` (e.g. focus already moved away),
 * we return `null` so callers can bail out cleanly instead of using a
 * stale offset.
 */
export function getSerializedCaretOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  if (!root.contains(node) && node !== root) return null;
  const doc = root.ownerDocument ?? document;
  const range = doc.createRange();
  try {
    range.setStart(root, 0);
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  const fragment = range.cloneContents();
  const holder = doc.createElement("div");
  holder.appendChild(fragment);
  return serializeContentEditable(holder).length;
}

/**
 * Inverse of `getSerializedCaretOffset`: given a target offset in the
 * serialized string, walk `root`'s children and return the DOM position
 * (container + offset) that a Range can seek to.
 *
 * Chips are atomic: if the target lands strictly inside a token we snap
 * to the position just before the chip; a target exactly at `tokenLen`
 * naturally falls to the next sibling.
 */
export function findDomPositionFromOffset(
  root: HTMLElement,
  target: number,
): { node: Node; offset: number } {
  let remaining = Math.max(0, target);
  const search = (parent: Node): { node: Node; offset: number } | null => {
    const children = Array.from(parent.childNodes);
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.nodeType === Node.TEXT_NODE) {
        const len = (child.textContent ?? "").length;
        if (remaining <= len) return { node: child, offset: remaining };
        remaining -= len;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      if (el.tagName === "BR") {
        if (remaining === 0) return { node: parent, offset: i };
        remaining -= 1;
        continue;
      }
      if (isMentionChip(el)) {
        const tokenLen = chipToToken(el).length;
        if (remaining < tokenLen) return { node: parent, offset: i };
        remaining -= tokenLen;
        continue;
      }
      if (el.tagName === "DIV" || el.tagName === "P") {
        // Match the serialize side: implicit `\n` before this block
        // when there was any preceding content.
        if (i > 0 || (parent === root && parent.childNodes[0] !== el)) {
          if (remaining === 0) return { node: parent, offset: i };
          remaining -= 1;
        }
      }
      const nested = search(child);
      if (nested) return nested;
    }
    return null;
  };
  const found = search(root);
  if (found) return found;
  return { node: root, offset: root.childNodes.length };
}
