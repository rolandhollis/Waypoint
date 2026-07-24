import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";
import { getMentionRanges, parseMentions } from "../lib/mentions";
import type { MentionableUser } from "../lib/queries";
import { MentionPicker } from "./MentionPicker";

/**
 * Textarea + @mention picker + styled-token overlay, all in one.
 *
 * The `<textarea>` still owns the raw string, including the full
 * `@[Name](user:UUID)` tokens — the parser + save path never see
 * anything different. On top of the textarea we render a
 * `pointer-events: none` overlay div in the same font / padding /
 * line-height / border-box, but with the raw text of each token
 * swapped for a styled `@Name` chip.
 *
 * Layering:
 *   1. Wrapper       — `position: relative`, sizes to the textarea.
 *   2. Overlay div   — `absolute inset-0`, `pointer-events: none`,
 *                       `overflow: hidden`, `aria-hidden`. Content
 *                       is translated by `-scrollTop / -scrollLeft`
 *                       on textarea scroll so wrapping / offset
 *                       matches the textarea line-for-line.
 *   3. Textarea      — the actual editable element, with
 *                       `color: transparent` so its raw text isn't
 *                       drawn; `caret-color: [visible]` so the
 *                       caret keeps being drawn by the browser.
 *                       `background: transparent` so the overlay
 *                       shows through; `.input` still owns the
 *                       border + focus ring.
 *
 * The overlay's font / padding / border-widths are copied from
 * `getComputedStyle(textarea)` at mount + on window resize, matching
 * the caret-mirror technique in `MentionPicker.tsx` — this avoids
 * duplicating Tailwind class strings and stays correct regardless
 * of which parent tacked on `text-sm` / `min-h-[…]` / etc.
 *
 * The overlay renders even when the textarea is `disabled` (viewer
 * read-only) — viewers still deserve to see mentions as styled
 * chips rather than the raw `@[Name](user:UUID)` tokens. Only the
 * caret / focus ring machinery is skipped when disabled.
 */
export type MentionTextareaProps = {
  value: string;
  onChange: (next: string) => void;
  users: readonly MentionableUser[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Chained after the picker's own key handler. The picker may call
   * `preventDefault` to consume arrow / Enter / Tab / Escape while
   * open — the wrapper only invokes this callback when the picker
   * left the event alone, matching the "let the popover eat its
   * shortcuts first" pattern the composer already used inline.
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
};

// Style properties copied from the textarea onto the overlay so
// wrapping + line metrics match pixel-for-pixel. Same list the
// caret-mirror technique in MentionPicker uses, extended with a few
// more props that affect visible layout (background, color) so we
// don't accidentally repaint them.
const OVERLAY_COPY_PROPS = [
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "tabSize",
] as const;

function readMirrorStyle(
  textarea: HTMLTextAreaElement,
): React.CSSProperties {
  const cs = window.getComputedStyle(textarea);
  const out: Record<string, string> = {};
  for (const prop of OVERLAY_COPY_PROPS) {
    const val = (cs as unknown as Record<string, string>)[prop as string];
    if (val != null) out[prop as string] = val;
  }
  // Ensure text wraps identically to the textarea. `whitespace-pre-wrap`
  // preserves newlines + collapses runs of spaces, matching a plain
  // textarea's rendering.
  out.whiteSpace = out.whiteSpace || "pre-wrap";
  out.wordWrap = "break-word";
  // Overlay must not draw its own border color or background — the
  // textarea below still owns those visuals. Border-WIDTHs stay
  // (copied above) so the content box aligns with the textarea's.
  out.borderStyle = "solid";
  out.borderColor = "transparent";
  out.background = "transparent";
  return out as React.CSSProperties;
}

export const MentionTextarea = forwardRef<
  HTMLTextAreaElement,
  MentionTextareaProps
>(function MentionTextarea(
  { value, onChange, users, className, placeholder, disabled, onKeyDown },
  forwardedRef,
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const [mirrorStyle, setMirrorStyle] = useState<React.CSSProperties>({});
  const [scroll, setScroll] = useState({ top: 0, left: 0 });

  // Sync the overlay's font + padding + border widths with the
  // textarea. Runs on mount, on window resize, and whenever the
  // consumer's className changes (which typically drives the box).
  useLayoutEffect(() => {
    const ta = localRef.current;
    if (!ta) return;
    const measure = () => setMirrorStyle(readMirrorStyle(ta));
    measure();
    // ResizeObserver picks up on `resize-y` drags AND on wrapper
    // width changes (which alter line-wrap). Falls back to the
    // window resize listener for older environments.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => measure());
      observer.observe(ta);
    }
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [className]);

  // Bind the local ref to the picker's ref AND any external forwarded
  // ref so callers can still `focus()` the textarea if they want.
  const composedRef = useCallback(
    (pickerRef: React.MutableRefObject<HTMLTextAreaElement | null>) =>
      (el: HTMLTextAreaElement | null) => {
        localRef.current = el;
        pickerRef.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      },
    [forwardedRef],
  );

  const segments = useMemo(() => parseMentions(value), [value]);

  /**
   * Intercept edit-shape keys so mention tokens behave atomically
   * regardless of the raw `@[Name](user:UUID)` characters that live
   * in the underlying textarea value:
   *
   *   Backspace at end of a mention → deletes the whole token.
   *   Delete    at start of a mention → deletes the whole token.
   *   Backspace/Delete with a range selection that partially
   *     overlaps any mention → the range is extended to whole
   *     tokens BEFORE the deletion runs, so the user can never end
   *     up with half a token in the value.
   *   ArrowLeft / ArrowRight at a token boundary → jump to the
   *     other boundary in one keystroke (nice-to-have).
   *   Cmd/Ctrl+X / Cmd/Ctrl+C with a range partially inside a
   *     mention → extend the range to whole tokens BEFORE the
   *     default cut/copy runs, so the clipboard payload is a
   *     complete token (the "storage format on the wire" non-goal
   *     means the clipboard gets the raw token — a future polish
   *     could rewrite it to `@Name` via a custom onCopy handler).
   *
   * Skips entirely when there are no mentions in the value or the
   * user is mid-IME-composition (`isComposing`) so we don't
   * interfere with dead-key sequences.
   */
  const handleAtomicKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = localRef.current;
    if (!ta) return;
    // Ignore IME composition — some browsers deliver Backspace
    // during composition and clobbering the value would break dead-
    // key sequences.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const ranges = getMentionRanges(value);
    if (ranges.length === 0) return;

    const selStart = ta.selectionStart ?? 0;
    const selEnd = ta.selectionEnd ?? 0;
    const collapsed = selStart === selEnd;
    const noMods = !e.altKey && !e.metaKey && !e.ctrlKey;

    const applyReplace = (from: number, to: number, caret: number) => {
      const next = value.slice(0, from) + value.slice(to);
      onChange(next);
      // Restore caret after React commits the new value — same
      // pattern the picker uses on selection insert.
      requestAnimationFrame(() => {
        const el = localRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    };

    const extendedRange = (
      a: number,
      b: number,
    ): [number, number] | null => {
      let s = Math.min(a, b);
      let ep = Math.max(a, b);
      let changed = false;
      for (const r of ranges) {
        // Strict inequality: `s === r.start` already sits on the
        // boundary and shouldn't drag the selection wider.
        if (s > r.start && s < r.end) {
          s = r.start;
          changed = true;
        }
        if (ep > r.start && ep < r.end) {
          ep = r.end;
          changed = true;
        }
      }
      return changed ? [s, ep] : null;
    };

    if (e.key === "Backspace" && collapsed && noMods) {
      const m = ranges.find((r) => selStart === r.end);
      if (m) {
        e.preventDefault();
        applyReplace(m.start, m.end, m.start);
        return;
      }
    }

    if (e.key === "Delete" && collapsed && noMods) {
      const m = ranges.find((r) => selStart === r.start);
      if (m) {
        e.preventDefault();
        applyReplace(m.start, m.end, m.start);
        return;
      }
    }

    // Range deletion where the selection partially overlaps a
    // token — extend to whole tokens and delete in one shot.
    if ((e.key === "Backspace" || e.key === "Delete") && !collapsed) {
      const ext = extendedRange(selStart, selEnd);
      if (ext) {
        e.preventDefault();
        applyReplace(ext[0], ext[1], ext[0]);
        return;
      }
    }

    // Arrow-key traversal. Only bare ArrowLeft/Right — we leave
    // Shift+Arrow (selection extension), Alt+Arrow (word jump), and
    // Cmd/Ctrl+Arrow (line jump) to their platform defaults.
    if (e.key === "ArrowLeft" && collapsed && !e.shiftKey && noMods) {
      const m = ranges.find((r) => selStart === r.end);
      if (m) {
        e.preventDefault();
        ta.setSelectionRange(m.start, m.start);
        return;
      }
    }
    if (e.key === "ArrowRight" && collapsed && !e.shiftKey && noMods) {
      const m = ranges.find((r) => selStart === r.start);
      if (m) {
        e.preventDefault();
        ta.setSelectionRange(m.end, m.end);
        return;
      }
    }

    // Cut / copy — extend an in-progress selection to whole tokens
    // BEFORE the browser's default cut/copy fires. We do NOT
    // preventDefault: after `setSelectionRange` the browser reads
    // the new range and clipboard behavior falls out naturally.
    const isCutOrCopy =
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "x" || e.key === "X" || e.key === "c" || e.key === "C");
    if (isCutOrCopy && !collapsed) {
      const ext = extendedRange(selStart, selEnd);
      if (ext) ta.setSelectionRange(ext[0], ext[1]);
    }
  };

  return (
    <MentionPicker
      value={value}
      onChange={onChange}
      users={users}
      disabled={disabled}
      renderInput={({
        ref: pickerRef,
        onKeyDown: pickerKeyDown,
        onChange: pickerChange,
        onSelect,
        onBlur,
      }) => (
        <div className="relative">
          {/* Overlay sits behind the textarea in DOM order so the
              browser draws the textarea (and its caret) on top of
              it. `pointer-events: none` keeps mouse events flowing
              to the textarea beneath. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 overflow-hidden text-wp-ink",
              className,
            )}
            style={{
              ...mirrorStyle,
              // The overlay owns *display*; it must not itself
              // scroll — the inner content wrapper translates
              // instead so wrapping stays identical to the
              // textarea below.
              overflow: "hidden",
            }}
          >
            <div
              style={{
                // Translate up/left by the textarea's scroll so
                // rendered lines stay aligned with the textarea's
                // visible lines. When scrollTop=0 the first line
                // lands right below the (shared) padding-top.
                transform: `translate(${-scroll.left}px, ${-scroll.top}px)`,
                width: "100%",
                // Inherit wrap behavior from the outer overlay by
                // mirroring the same properties the outer had
                // copied from the textarea. `overflow-wrap` /
                // `word-break` aren't inheritable by default so
                // the inner has to spell them out too.
                whiteSpace: (mirrorStyle.whiteSpace as string) ?? "pre-wrap",
                wordBreak:
                  (mirrorStyle.wordBreak as
                    | React.CSSProperties["wordBreak"]
                    | undefined) ?? "normal",
                overflowWrap:
                  (mirrorStyle.overflowWrap as
                    | React.CSSProperties["overflowWrap"]
                    | undefined) ?? "break-word",
              }}
            >
              {segments.length === 0 ? (
                // Empty content — nothing to draw. Placeholder is
                // handled entirely by the textarea below, so the
                // overlay staying blank is correct.
                null
              ) : (
                <>
                  {segments.map((seg, i) => {
                    if (seg.kind === "text") {
                      // Wrap in <span> so React keeps stable
                      // children between renders; text nodes as
                      // direct children fight harder with keys.
                      return <span key={i}>{seg.text}</span>;
                    }
                    return (
                      <span
                        key={i}
                        className="rounded-sm font-medium text-wp-red"
                        title={seg.displayName}
                      >
                        @{seg.displayName}
                      </span>
                    );
                  })}
                  {/* Trailing zero-width joiner ensures a final
                      newline in `value` still produces a visible
                      empty line in the overlay (matches the
                      textarea's rendering of a trailing \n). */}
                  {"\u200B"}
                </>
              )}
            </div>
          </div>
          <textarea
            ref={composedRef(pickerRef)}
            className={cn(
              // The textarea keeps its own `.input` chrome (border,
              // focus ring, placeholder color) but its raw text is
              // hidden — the overlay draws the styled version.
              className,
              "relative bg-transparent text-transparent",
            )}
            style={{
              // Keep the browser drawing a visible caret even
              // though the underlying text is transparent — this is
              // the standard trick that makes the overlay pattern
              // feel like a normal textarea. Disabled textareas
              // don't get a caret from the browser anyway, so it's
              // safe to set unconditionally.
              caretColor: "#101828",
            }}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            // Turn off every "helpful" browser + extension text
            // annotator on this textarea. Otherwise the inserted
            // `@Name` chip is flagged as a misspelling and the
            // browser draws a dotted red underline right through
            // the styled overlay — the user reads that as random
            // "periods" trailing every mention. The overlay itself
            // is inert (aria-hidden, pointer-events: none), so no
            // attribute is needed there.
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            // Grammarly injects an overlay onto elements it wants
            // to check; these opt-out data-attrs are the vendor's
            // documented escape hatch.
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            onChange={pickerChange}
            onSelect={onSelect}
            onBlur={onBlur}
            onScroll={(e) => {
              const el = e.currentTarget;
              setScroll({ top: el.scrollTop, left: el.scrollLeft });
            }}
            onKeyDown={(e) => {
              // Order: the picker gets first crack (it consumes
              // arrows/enter/tab/escape while its popover is open),
              // then the atomic-mention handler runs (Backspace /
              // Delete / arrow-jump / cut+copy selection extension),
              // then the consumer's own onKeyDown (e.g. Cmd+Enter
              // to submit a comment).
              pickerKeyDown(e);
              if (e.defaultPrevented) return;
              handleAtomicKey(e);
              if (e.defaultPrevented) return;
              onKeyDown?.(e);
            }}
          />
        </div>
      )}
    />
  );
});

