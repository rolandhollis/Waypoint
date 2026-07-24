import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";
import { parseMentions } from "../lib/mentions";
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
            onChange={pickerChange}
            onSelect={onSelect}
            onBlur={onBlur}
            onScroll={(e) => {
              const el = e.currentTarget;
              setScroll({ top: el.scrollTop, left: el.scrollLeft });
            }}
            onKeyDown={(e) => {
              pickerKeyDown(e);
              if (e.defaultPrevented) return;
              onKeyDown?.(e);
            }}
          />
        </div>
      )}
    />
  );
});

