import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";
import {
  createMentionChip,
  deserializeIntoRoot,
  filterMentionCandidates,
  findActiveMentionQuery,
  findDomPositionFromOffset,
  getSerializedCaretOffset,
  serializeContentEditable,
} from "../lib/mentions";
import type { MentionableUser } from "../lib/queries";

/**
 * WYSIWYG @mention editor built on a plain `contenteditable` div.
 *
 * The previous incarnation used a native `<textarea>` plus a mirror
 * overlay: the textarea owned the raw `@[Name](user:UUID)` characters,
 * the overlay painted a styled `@Name` chip on top. That fundamentally
 * can't be caret-correct — the textarea's caret advances off the full
 * raw token width (~45+ chars) while only the visible `@Name` glyphs
 * were painted, so any text typed after a mention appeared to sit in a
 * wide empty strip beyond the chip.
 *
 * The contenteditable version renders each mention as a real atomic
 * inline element (`<span data-mention-user-id contenteditable="false">`).
 * Because chips are `contenteditable=false`, browsers treat them like
 * one glyph: caret can sit before/after but never enter, Backspace at
 * the trailing edge deletes the whole chip in one keystroke, and the
 * caret always sits exactly where the visible text ends.
 *
 * On the wire the format is unchanged: `serialize(root)` walks the DOM
 * back into the canonical `@[Name](user:UUID)` string the backend
 * parser + notification pipeline already speak. On mount + on any
 * external `value` change, `deserialize` rebuilds the DOM from that
 * same string. React never owns the editable children (mixing React
 * reconciliation with contenteditable is a known caret-jitter trap);
 * we sync via a useLayoutEffect that only touches the DOM when the
 * incoming `value` diverges from what `serialize(root)` currently
 * produces.
 */

export type MentionTextareaProps = {
  value: string;
  onChange: (next: string) => void;
  users: readonly MentionableUser[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Chained after the picker's own key handler. The picker consumes
   * arrow / Enter / Tab / Escape while its popover is open — this
   * callback is only invoked when the picker (and the editor's own
   * defaults) left the event alone, matching how `MentionPicker` used
   * to compose with `Cmd+Enter to submit` in the parent comment
   * composer.
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
};

/**
 * Imperative handle exposed via `ref`. Kept small: focus / blur / select
 * are the only mutators any caller might reasonably want, and they map
 * cleanly onto DOM primitives the editor already has.
 */
export type MentionTextareaHandle = {
  focus: () => void;
  blur: () => void;
  select: () => void;
};

type PickerState = {
  triggerStart: number;
  caret: number;
  query: string;
  rect: DOMRect | null;
};

export const MentionTextarea = forwardRef<
  MentionTextareaHandle,
  MentionTextareaProps
>(function MentionTextarea(
  { value, onChange, users, className, placeholder, disabled, onKeyDown },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  // `valueRef` mirrors the latest `value` prop so useCallback-created
  // handlers can compare against it without having to be recreated on
  // every keystroke — same trick the picker uses to avoid stale
  // closures on rapid typing.
  const valueRef = useRef(value);
  valueRef.current = value;

  const [picker, setPicker] = useState<PickerState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => rootRef.current?.focus(),
      blur: () => rootRef.current?.blur(),
      select: () => {
        const el = rootRef.current;
        if (!el) return;
        const doc = el.ownerDocument ?? document;
        const range = doc.createRange();
        range.selectNodeContents(el);
        const sel = doc.defaultView?.getSelection() ?? window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      },
    }),
    [],
  );

  // Reconcile DOM ↔ value only when the incoming `value` differs from
  // the current serialized DOM. Skipping the no-op case is what keeps
  // the caret from jittering after every keystroke — the input handler
  // has already applied the local edit; running deserialize would blow
  // away the caret + selection.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const current = serializeContentEditable(el);
    if (current === value) return;
    const doc = el.ownerDocument ?? document;
    const wasFocused = doc.activeElement === el;
    deserializeIntoRoot(el, value, doc);
    if (wasFocused) placeCaretAtEnd(el);
  }, [value]);

  const filtered = useMemo(() => {
    if (!picker) return [] as MentionableUser[];
    return filterMentionCandidates(users, picker.query);
  }, [picker, users]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  // Close the picker if the value gets cleared out from outside (e.g.
  // parent resets after a submit). Matches the old MentionPicker
  // behavior so a stale menu never lingers.
  useEffect(() => {
    if (!value) setPicker(null);
  }, [value]);

  const closePicker = useCallback(() => setPicker(null), []);

  const emitChange = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const next = serializeContentEditable(el);
    // After deleting all content some browsers leave a stray empty
    // text node or `<br>` behind. Clear the DOM so `.mention-editable:
    // empty::before` matches and the placeholder reappears.
    if (next === "" && el.childNodes.length > 0) el.innerHTML = "";
    if (next !== valueRef.current) onChange(next);
  }, [onChange]);

  const recomputePicker = useCallback(() => {
    if (disabled) {
      closePicker();
      return;
    }
    const el = rootRef.current;
    if (!el) return;
    const doc = el.ownerDocument ?? document;
    const sel = doc.defaultView?.getSelection() ?? window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      closePicker();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!range.collapsed) {
      closePicker();
      return;
    }
    if (!el.contains(range.endContainer) && range.endContainer !== el) {
      closePicker();
      return;
    }
    const caret = getSerializedCaretOffset(
      el,
      range.endContainer,
      range.endOffset,
    );
    if (caret == null) {
      closePicker();
      return;
    }
    const text = serializeContentEditable(el);
    const ctx = findActiveMentionQuery(text, caret);
    if (!ctx) {
      closePicker();
      return;
    }
    const rect = getCaretRect(range);
    setPicker((prev) => {
      if (
        prev &&
        prev.triggerStart === ctx.start &&
        prev.query === ctx.query
      ) {
        return { ...prev, caret, rect };
      }
      return { triggerStart: ctx.start, caret, query: ctx.query, rect };
    });
  }, [closePicker, disabled]);

  const commitSelection = useCallback(
    (user: MentionableUser) => {
      const el = rootRef.current;
      if (!el) return;
      const state = picker;
      if (!state) return;
      const doc = el.ownerDocument ?? document;
      // Locate `@…` trigger and current caret in DOM coordinates.
      const startPos = findDomPositionFromOffset(el, state.triggerStart);
      const endPos = findDomPositionFromOffset(el, state.caret);
      const range = doc.createRange();
      try {
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
      } catch {
        closePicker();
        return;
      }
      range.deleteContents();

      const chip = createMentionChip({ id: user.id, name: user.name }, doc);
      // Follow the picked chip with a trailing space so the user's
      // next keystroke isn't glued to the chip's visible text — same
      // behavior as `insertMentionAt` in the plain-text helper.
      const spaceNode = doc.createTextNode(" ");
      // Insert as a fragment so both nodes land in a single call —
      // avoids the "range.insertNode splits a text node and the caret
      // migrates unpredictably" trap that shows up when the range
      // sits inside a text node (which is exactly the case for the
      // `@…` query the user is typing when they trigger the picker).
      const fragment = doc.createDocumentFragment();
      fragment.appendChild(chip);
      fragment.appendChild(spaceNode);
      range.insertNode(fragment);

      const sel = doc.defaultView?.getSelection() ?? window.getSelection();
      if (sel) {
        const nextRange = doc.createRange();
        nextRange.setStartAfter(spaceNode);
        nextRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(nextRange);
      }

      closePicker();
      emitChange();
      // Selection state above changed — ensure any subsequent picker
      // recompute sees the settled DOM (RAF gives the browser a paint
      // tick to update `Selection.getRangeAt(0)`).
      requestAnimationFrame(() => {
        rootRef.current?.focus();
      });
    },
    [closePicker, emitChange, picker],
  );

  const handleInput = useCallback(() => {
    if (composingRef.current) return;
    emitChange();
    // Defer picker recompute to next frame so the browser has settled
    // Selection state after this input event.
    requestAnimationFrame(recomputePicker);
  }, [emitChange, recomputePicker]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      const el = rootRef.current;
      if (!el) return;
      const doc = el.ownerDocument ?? document;
      // Build up the fragment as if we were mounting fresh from `text`
      // so any `@[Name](user:UUID)` tokens in the paste come back as
      // real chips. Plain-text paste (no tokens) still works — the
      // deserializer yields a single text node.
      const holder = doc.createElement("div");
      deserializeIntoRoot(holder, text, doc);
      insertNodesAtCaret(el, Array.from(holder.childNodes));
      emitChange();
      requestAnimationFrame(recomputePicker);
    },
    [emitChange, recomputePicker],
  );

  // Copy / cut: serialize the current selection back to the on-wire
  // format so a chip pasted into another MentionTextarea (or back into
  // the same one after a full clipboard round-trip) resurrects as a
  // chip rather than as the visible `@Name` text alone.
  const handleCopy = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const el = rootRef.current;
      if (!el) return;
      const doc = el.ownerDocument ?? document;
      const sel = doc.defaultView?.getSelection() ?? window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;
      const holder = doc.createElement("div");
      holder.appendChild(range.cloneContents());
      const text = serializeContentEditable(holder);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    },
    [],
  );

  const handleCut = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const el = rootRef.current;
      if (!el) return;
      const doc = el.ownerDocument ?? document;
      const sel = doc.defaultView?.getSelection() ?? window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;
      const holder = doc.createElement("div");
      holder.appendChild(range.cloneContents());
      const text = serializeContentEditable(holder);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
      range.deleteContents();
      emitChange();
      requestAnimationFrame(recomputePicker);
    },
    [emitChange, recomputePicker],
  );

  const insertLineBreakAtCaret = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const doc = el.ownerDocument ?? document;
    const sel = doc.defaultView?.getSelection() ?? window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) && range.startContainer !== el) return;
    range.deleteContents();
    // Insert a literal `\n` text node rather than a `<br>` element.
    // The editor's `white-space: pre-wrap` styling renders `\n` as a
    // line break, and it round-trips cleanly through serialize (which
    // just reads text-node textContent) without the trailing-`<br>`-
    // isn't-visible headaches Chrome/WebKit inflict on contenteditable.
    const textNode = doc.createTextNode("\n");
    range.insertNode(textNode);
    const nextRange = doc.createRange();
    nextRange.setStartAfter(textNode);
    nextRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nextRange);
    emitChange();
    requestAnimationFrame(recomputePicker);
  }, [emitChange, recomputePicker]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Picker gets first crack — arrow / Enter / Tab / Escape while
      // the popover is open shouldn't fall through to editor
      // defaults or the consumer's onKeyDown.
      if (picker) {
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
            filtered.length === 0
              ? 0
              : (i - 1 + filtered.length) % filtered.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          const user = filtered[activeIndex];
          e.preventDefault();
          if (user) commitSelection(user);
          else closePicker();
          return;
        }
        if (e.key === "Escape") {
          // Stop propagation so an ancestor dismissable layer (Radix
          // Dialog) doesn't ALSO close on the same key press — first
          // Escape closes the picker; a second closes the surface.
          e.preventDefault();
          e.stopPropagation();
          closePicker();
          return;
        }
      }

      // Cmd/Ctrl+Enter must reach the consumer (used for submit in
      // the comment composer). Only intercept bare / Shift+Enter for
      // the line-break behavior contenteditable would otherwise wrap
      // in an unwanted `<div>` / `<p>`.
      if (
        e.key === "Enter" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        insertLineBreakAtCaret();
        return;
      }

      onKeyDown?.(e);
    },
    [
      activeIndex,
      closePicker,
      commitSelection,
      filtered,
      insertLineBreakAtCaret,
      onKeyDown,
      picker,
    ],
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
    // Compose sequences finalize on `compositionend`, not on the
    // synthetic `input` fired during composition. Emit here so the
    // parent picks up the final IME glyph.
    emitChange();
    requestAnimationFrame(recomputePicker);
  }, [emitChange, recomputePicker]);

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      // Ignore blur when focus moved into the picker (mouse click on
      // a candidate). The candidate's onMouseDown handles the pick.
      const next = e.relatedTarget as HTMLElement | null;
      if (next && menuRef.current?.contains(next)) return;
      closePicker();
    },
    [closePicker],
  );

  // Fire `recomputePicker` also on caret moves that don't trigger an
  // input event (Arrow keys, click into a different position). React
  // doesn't expose a `selectionchange` handler on divs, so we bind
  // manually and gate on focus so we don't recompute for the wrong
  // editor when multiple are mounted (comment composer + description).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const doc = el.ownerDocument ?? document;
    const onSelectionChange = () => {
      if (doc.activeElement !== el) return;
      recomputePicker();
    };
    doc.addEventListener("selectionchange", onSelectionChange);
    return () => doc.removeEventListener("selectionchange", onSelectionChange);
  }, [recomputePicker]);

  // Recompute the caret rect on scroll / resize so the popover tracks
  // the caret if the surrounding layout shifts.
  useLayoutEffect(() => {
    if (!picker) return;
    const onLayoutChange = () => recomputePicker();
    window.addEventListener("scroll", onLayoutChange, true);
    window.addEventListener("resize", onLayoutChange);
    return () => {
      window.removeEventListener("scroll", onLayoutChange, true);
      window.removeEventListener("resize", onLayoutChange);
    };
  }, [picker, recomputePicker]);

  // Outside-pointerdown closes the picker.
  useEffect(() => {
    if (!picker) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closePicker();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [picker, closePicker]);

  return (
    <div className="relative">
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline="true"
        aria-disabled={disabled ? true : undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder ?? ""}
        // Tailwind can't reach `[contenteditable]` pseudo-empty:before
        // directly, so the visual styles live in `index.css` under the
        // `.mention-editable` selector — placeholder color and chip
        // rendering. Min-height / padding / border still come from the
        // parent's className (usually `.input min-h-…`).
        className={cn("mention-editable", className)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        // Grammarly-style overlay opt-outs — same rationale as the
        // native-textarea version: extension underlines would draw
        // through the chip and read as random punctuation.
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onCut={handleCut}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onBlur={handleBlur}
      />
      {picker && picker.rect ? (
        <MentionMenu
          menuRef={menuRef}
          rect={picker.rect}
          candidates={filtered}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={commitSelection}
        />
      ) : null}
    </div>
  );
});

/**
 * Insert one or more nodes at the current selection inside `root`,
 * replacing any range selection. Uses a DocumentFragment so both
 * ordering and caret placement stay deterministic even when the range
 * starts inside a text node (where consecutive `range.insertNode`
 * calls have historically been unreliable across browsers).
 */
function insertNodesAtCaret(root: HTMLElement, nodes: Node[]) {
  if (nodes.length === 0) return;
  const doc = root.ownerDocument ?? document;
  const sel = doc.defaultView?.getSelection() ?? window.getSelection();
  const fragment = doc.createDocumentFragment();
  for (const node of nodes) fragment.appendChild(node);
  const last = nodes[nodes.length - 1];
  if (!sel || sel.rangeCount === 0) {
    // No live caret — append at the end so pasted content isn't lost.
    root.appendChild(fragment);
    if (last) placeCaretAfter(root, last);
    return;
  }
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) && range.startContainer !== root) {
    root.appendChild(fragment);
    if (last) placeCaretAfter(root, last);
    return;
  }
  range.deleteContents();
  range.insertNode(fragment);
  if (last) placeCaretAfter(root, last);
}

function placeCaretAfter(root: HTMLElement, node: Node) {
  const doc = root.ownerDocument ?? document;
  const sel = doc.defaultView?.getSelection() ?? window.getSelection();
  if (!sel) return;
  const range = doc.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(root: HTMLElement) {
  const doc = root.ownerDocument ?? document;
  const range = doc.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  const sel = doc.defaultView?.getSelection() ?? window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Return a viewport-coordinate rect for the current collapsed range.
 * For most positions `range.getBoundingClientRect()` returns a zero-
 * width rect at the caret — that's enough for popover placement. For
 * positions immediately after a `contenteditable=false` chip some
 * engines return an all-zeros rect; in that case we fall back to the
 * chip's own bounding rect so the popover still lands sensibly.
 */
function getCaretRect(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  const node = range.startContainer;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    const child = el.childNodes[range.startOffset - 1] as HTMLElement | undefined;
    const fallback = child?.getBoundingClientRect?.();
    if (fallback) return fallback;
  }
  return rect;
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
  const style: React.CSSProperties = {
    position: "fixed",
    top: rect.bottom + 4,
    left: rect.left,
    width: 288,
    maxHeight: 240,
    zIndex: 60,
  };

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
      // Stop pointerdown/mousedown at the menu boundary so any outside
      // dismissable layer (Radix Dialog, our own useEffect above)
      // doesn't fire on a candidate click. Even though the menu is a
      // DOM descendant of the editor's wrapper, some dismissable-layer
      // implementations still resolve "inside" via event-target
      // heuristics — defence-in-depth against that.
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
