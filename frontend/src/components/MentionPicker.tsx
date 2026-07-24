import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  filterMentionCandidates,
  findActiveMentionQuery,
  insertMentionAt,
  type MentionableUser,
} from "../lib/mentions";

/**
 * Caret-anchored @mention picker.
 *
 * The picker sits above the textarea's current caret position; as
 * the user types after `@`, the roster filters case-insensitively
 * on name OR email. Selection can happen with mouse, or Enter /
 * Tab from the keyboard; Escape or a click outside the picker
 * closes without inserting anything.
 *
 * Wraps whichever text control the caller supplies via
 * `renderInput`. That callback gets back a ref for the underlying
 * `<textarea>` plus a small set of controlled event handlers the
 * caller has to attach — this avoids the picker having to know
 * about styling / class names / disabled state, which vary between
 * the comment composer, the comment editor, and the description
 * field.
 *
 * IMPORTANT: no new dependency. Popover / caret positioning is done
 * with a hidden "mirror" DOM node that copies the textarea's font +
 * geometry and lays out a run of characters up to the caret, then
 * reads the position of the caret marker's bounding rect. Same
 * technique used by every mention library in the wild.
 */

// Font / layout properties copied from the textarea onto the mirror
// so its wrapping and metrics match pixel-for-pixel. Anything not
// on this list is inherited via inline `style`.
const MIRROR_STYLE_PROPS: readonly (keyof CSSStyleDeclaration)[] = [
  "boxSizing",
  "width",
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

/**
 * Measure the pixel position of the caret inside `textarea`. We do
 * this by creating a hidden div that mirrors the textarea's layout,
 * putting all the text-up-to-caret in it, then inserting an inline
 * marker span at the caret position and reading its client rect.
 *
 * Returns a rect in viewport coordinates so the popover can be
 * placed with `position: fixed` without any parent-relative math.
 */
function measureCaretRect(
  textarea: HTMLTextAreaElement,
  caret: number,
): DOMRect | null {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const doc = textarea.ownerDocument ?? document;

  // Copy visual + layout properties onto the mirror.
  for (const prop of MIRROR_STYLE_PROPS) {
    // Setting via style[...] is safe with computed values; the
    // property list above is intentionally strict.
    (mirror.style as unknown as Record<string, string>)[prop as string] =
      (style as unknown as Record<string, string>)[prop as string] ?? "";
  }
  // Position mirror over the textarea so the client rect math lands
  // in the same coordinate space. `visibility: hidden` keeps it
  // measurable without flashing to the user.
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.zIndex = "-1";
  mirror.style.whiteSpace = mirror.style.whiteSpace || "pre-wrap";
  mirror.style.wordWrap = "break-word";

  const rect = textarea.getBoundingClientRect();
  mirror.style.top = `${window.scrollY + rect.top}px`;
  mirror.style.left = `${window.scrollX + rect.left}px`;
  // Fixed height so the mirror doesn't grow past the viewport when
  // measuring long bodies. We're only reading the marker's rect,
  // not visually rendering.
  mirror.style.height = `${textarea.clientHeight}px`;

  // Split value into before-caret + caret marker + after-caret so
  // the marker gets a stable rect regardless of text wrapping.
  const value = textarea.value;
  const before = value.slice(0, caret);
  const after = value.slice(caret) || " ";

  mirror.textContent = "";
  mirror.appendChild(doc.createTextNode(before));
  const marker = doc.createElement("span");
  marker.textContent = "|"; // any glyph works; we only read its rect
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  mirror.appendChild(marker);
  mirror.appendChild(doc.createTextNode(after));

  document.body.appendChild(mirror);
  // Account for the textarea's own scroll so the caret rect tracks
  // the visible caret in a scrolled textarea.
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
  const markerRect = marker.getBoundingClientRect();
  document.body.removeChild(mirror);
  return markerRect;
}

export type MentionPickerRenderInputArgs = {
  ref: React.MutableRefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
};

/**
 * Wrap a textarea in @mention behavior. Rendering the actual
 * textarea is caller-controlled via `renderInput` — this component
 * owns only the picker overlay + caret detection + insertion.
 */
export function MentionPicker({
  value,
  onChange,
  users,
  disabled,
  renderInput,
}: {
  value: string;
  onChange: (next: string) => void;
  users: readonly MentionableUser[];
  disabled?: boolean;
  renderInput: (args: MentionPickerRenderInputArgs) => React.ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // `open` is null when the picker is closed; when open it carries
  // enough context to (a) filter the roster and (b) know which range
  // to replace on insert.
  const [open, setOpen] = useState<{
    triggerStart: number;
    caret: number;
    query: string;
    rect: DOMRect | null;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    if (!open) return [] as MentionableUser[];
    return filterMentionCandidates(users, open.query);
  }, [open, users]);

  // Keep activeIndex in bounds as the filtered list shrinks.
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  // Close the picker when the underlying value is emptied out (e.g.
  // parent reset after a submit).
  useEffect(() => {
    if (!value) setOpen(null);
  }, [value]);

  const closePicker = () => setOpen(null);

  const recomputeFromCaret = () => {
    if (disabled) {
      closePicker();
      return;
    }
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? 0;
    const ctx = findActiveMentionQuery(ta.value, caret);
    if (!ctx) {
      closePicker();
      return;
    }
    const rect = measureCaretRect(ta, caret);
    setOpen((prev) => {
      // Preserve the highlight if the query is just being extended.
      if (
        prev &&
        prev.triggerStart === ctx.start &&
        prev.query === ctx.query
      ) {
        return { ...prev, caret, rect };
      }
      return { triggerStart: ctx.start, caret, query: ctx.query, rect };
    });
  };

  const commitSelection = (user: MentionableUser) => {
    if (!open) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const { text, caret } = insertMentionAt({
      text: value,
      triggerStart: open.triggerStart,
      caret: open.caret,
      user: { id: user.id, name: user.name },
    });
    onChange(text);
    closePicker();
    // Restore caret after React updates the value.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    // Defer measurement until the browser has laid out the new
    // value — otherwise the caret rect lags by one keystroke.
    requestAnimationFrame(recomputeFromCaret);
  };

  const handleSelect = (_e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    // Cursor moved via arrow keys or mouse; re-evaluate whether
    // we're inside a query. Deferred to next frame so
    // `selectionStart` reflects the browser's post-event state.
    requestAnimationFrame(recomputeFromCaret);
  };

  const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    // Don't close if focus moved into the picker menu (mouse click
    // on a candidate). The Space/Enter/click that lands inside
    // `menuRef` will call `commitSelection` and close itself.
    const next = e.relatedTarget as HTMLElement | null;
    if (next && menuRef.current && menuRef.current.contains(next)) return;
    closePicker();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) =>
        filtered.length === 0 ? 0 : (i + 1) % filtered.length,
      );
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      );
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const user = filtered[activeIndex];
      if (user) {
        e.preventDefault();
        commitSelection(user);
      }
      return;
    }
    if (e.key === "Escape") {
      // Stop propagation so an outer dismissable layer (e.g. the
      // Radix Dialog around the project detail modal) doesn't also
      // close on the same key press — Escape should first close the
      // picker; a second Escape closes the surrounding surface.
      e.preventDefault();
      e.stopPropagation();
      closePicker();
      return;
    }
  };

  // Outside-click handler — a mouse click that lands outside both
  // the textarea AND the picker menu should close the popover.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (textareaRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closePicker();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // Recompute the caret rect on scroll / resize so the popover
  // tracks the caret when the surrounding layout shifts.
  useLayoutEffect(() => {
    if (!open) return;
    const onLayoutChange = () => recomputeFromCaret();
    window.addEventListener("scroll", onLayoutChange, true);
    window.addEventListener("resize", onLayoutChange);
    return () => {
      window.removeEventListener("scroll", onLayoutChange, true);
      window.removeEventListener("resize", onLayoutChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.triggerStart]);

  return (
    <>
      {renderInput({
        ref: textareaRef,
        onKeyDown: handleKeyDown,
        onChange: handleChange,
        onSelect: handleSelect,
        onBlur: handleBlur,
      })}
      {open && open.rect ? (
        // Rendered inline (NOT via createPortal) so the menu stays a
        // DOM descendant of whichever container the picker was
        // instantiated in. That matters because Radix's Dialog uses a
        // "dismissable layer" that treats any pointerdown OUTSIDE
        // its content tree as a request to close the modal — a
        // portal to document.body would fire that dismissal on
        // every candidate click and unmount the menu before its
        // onMouseDown ever ran. `position: fixed` on the menu
        // itself still escapes any intermediate `overflow` clipping,
        // so we don't lose the layered-above-scroll behavior.
        <MentionMenu
          menuRef={menuRef}
          rect={open.rect}
          candidates={filtered}
          activeIndex={activeIndex}
          onHover={(i) => setActiveIndex(i)}
          onPick={commitSelection}
        />
      ) : null}
    </>
  );
}

const MentionMenu = ({
  menuRef,
  rect,
  candidates,
  activeIndex,
  onHover,
  onPick,
}: {
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  rect: DOMRect;
  candidates: readonly MentionableUser[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (user: MentionableUser) => void;
}) => {
  // Place the menu ~24px below the caret so it hangs beneath the
  // active line without covering the character the user just typed.
  const style: React.CSSProperties = {
    position: "fixed",
    top: rect.bottom + 4,
    left: rect.left,
    // Cap width so long names / emails still wrap gracefully.
    width: 288,
    maxHeight: 240,
    zIndex: 60,
  };

  // Keep the active row in view when the user arrow-keys past the
  // visible window.
  const listRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={menuRef}
      style={style}
      role="listbox"
      aria-label="Mention a user"
      // Stop pointerdown / mousedown at the menu boundary so ANY
      // outside-click layer (Radix Dialog dismissal, our own
      // useEffect below) doesn't fire on a candidate click. Even
      // though the menu is a DOM descendant of Dialog.Content now,
      // some dismissable-layer implementations still resolve
      // "inside" via `event.target` heuristics — this is
      // defence-in-depth against that.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="overflow-hidden rounded-md border border-wp-stone bg-white shadow-lg"
    >
      <div ref={listRef} className="max-h-60 overflow-y-auto p-1">
        {candidates.length === 0 ? (
          <p className="px-2 py-3 text-xs text-wp-slate">No matching users.</p>
        ) : null}
        {candidates.map((user, i) => (
          <button
            key={user.id}
            type="button"
            role="option"
            data-index={i}
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              // MouseDown fires BEFORE the textarea's blur handler
              // (which would otherwise close the picker and eat
              // this click). preventDefault keeps the textarea
              // focused (so the caret survives the selection);
              // stopPropagation keeps this click from bubbling to
              // any ancestor outside-click detector.
              e.preventDefault();
              e.stopPropagation();
              onPick(user);
            }}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none",
              i === activeIndex
                ? "bg-wp-red/10 text-wp-ink"
                : "text-wp-ink hover:bg-wp-stone/40",
            )}
          >
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
              style={{ background: user.color }}
              aria-hidden
            >
              {initials(user.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{user.name}</span>
              <span className="block truncate text-[11px] text-wp-slate">
                {user.email}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
