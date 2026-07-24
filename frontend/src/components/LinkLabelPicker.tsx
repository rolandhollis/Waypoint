import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "../lib/cn";
import { useLinkLabelSuggestions } from "../lib/queries";

/**
 * Built-in defaults that are always offered by the label picker,
 * even before any link exists in the tenant. See the task spec:
 * "Jira" is the first suggestion + the default on a fresh link.
 * Case is preserved when users pick these — a link created with
 * "Jira" stores the string "Jira" (not "jira"), so display casing
 * follows whatever the picker saw at commit time.
 *
 * Order is deliberate — tickets first (most common quick-jump),
 * then doc-like artifacts (PRD, Confluence) grouped together, then
 * design (Figma) at the end. New link-shaped artifacts should slot
 * in with their kind rather than at the tail so users see related
 * options adjacent in the dropdown.
 */
export const BUILT_IN_LABELS = ["Jira", "PRD", "Confluence", "Figma"] as const;

/** Default label the parent form should preseed on a fresh link. */
export const DEFAULT_NEW_LABEL = "Jira";

/**
 * Single-value combobox for picking a link label. Union of:
 *   * the server-side DISTINCT list (per-group, via
 *     useLinkLabelSuggestions),
 *   * the built-in defaults (see BUILT_IN_LABELS above — currently
 *     Jira, PRD, Confluence, Figma),
 *   * anything already typed into the input that doesn't match
 *     — surfaced as a "Create '<typed>'" row so a brand-new label
 *     can be coined inline without leaving the form.
 *
 * Dedupe is case-insensitive; the FIRST occurrence's casing wins
 * so "Jira" from BUILT_IN_LABELS wins over "jira" from an older
 * user-entered row (rare, but possible if a PM once typed "jira").
 * That mirrors the tag picker's normalize-but-preserve-original
 * approach.
 *
 * Rendering: portal into <body> with `position: fixed`, anchored
 * to the trigger's bounding rect. The detail-panel modal sits in
 * its own overflow-hidden Radix container, so an in-DOM absolute
 * popover would get clipped at the panel edge — same fix that
 * FilterBar's MultiSelect uses.
 */
export function LinkLabelPicker({
  value,
  onChange,
  disabled,
  className,
  placeholder = "Label",
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  /** Focus the input on mount — passed by the inline forms so
   *  entering add-mode lands the caret in the label field. */
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Keep the input's visible text in sync with `value` while the
  // dropdown is closed. When the dropdown IS open, `query` drives
  // the input independently so the user can type-to-filter without
  // clobbering the persisted value until they commit a selection.
  useEffect(() => {
    if (!open) setQuery(value);
  }, [value, open]);

  const suggestions = useLinkLabelSuggestions();

  // Build the combined option list. Order:
  //   1. Built-in defaults (BUILT_IN_LABELS) — first, so they
  //      surface even when the server list is empty. Order within
  //      the built-in list is preserved (tickets, then docs, then
  //      design), NOT alphabetized, so related types stay adjacent.
  //   2. Server-side DISTINCT labels, alphabetical (server already
  //      sorts by lower(label) but we resort defensively so a
  //      case-quirk in the DB doesn't leak here).
  // Dedupe is case-insensitive; the first casing seen wins so the
  // built-ins keep their canonical spelling even if a user once
  // typed a lowercase variant.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (s: string) => {
      const key = s.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(s.trim());
    };
    for (const b of BUILT_IN_LABELS) add(b);
    const serverLabels = [...(suggestions.data?.labels ?? [])].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    for (const s of serverLabels) add(s);
    return out;
  }, [suggestions.data?.labels]);

  const normalizedQuery = query.trim();
  const normalizedLower = normalizedQuery.toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedLower) return options;
    return options.filter((o) => o.toLowerCase().includes(normalizedLower));
  }, [options, normalizedLower]);

  // "Create '<typed>'" is offered only when the trimmed input has
  // content AND doesn't exactly match a known option (case-insensitively).
  const canCreate =
    normalizedQuery.length > 0 &&
    !options.some((o) => o.toLowerCase() === normalizedLower);

  // Position the popover under the trigger, sized to at least
  // the trigger's width so short labels don't produce a pinched
  // dropdown. Recomputed on open/resize/scroll — same pattern as
  // FilterBar's MultiSelect to survive nested scroll containers.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    function place() {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const GAP = 4;
      const VIEWPORT_MARGIN = 8;
      const spaceBelow = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      const maxHeight = Math.max(160, Math.min(256, spaceBelow));
      setPos({ top: rect.bottom + GAP, left: rect.left, width: rect.width, maxHeight });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Outside click + Escape close the popover. Outside = not the
  // trigger wrapper AND not the portal surface.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
      // Snap the input back to the committed value on outside close
      // — clicking away shouldn't leave a half-typed string in the
      // field pretending to be the label.
      setQuery(value);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery(value);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, value]);

  function commit(next: string) {
    const trimmed = next.trim();
    if (!trimmed) return;
    onChange(trimmed);
    setQuery(trimmed);
    setOpen(false);
  }

  const popover = open && pos ? createPortal(
    <div
      ref={popoverRef}
      // z-50 so this floats above the Radix Dialog overlay (z-40)
      // AND the dialog content (z-50 in the panel). We rely on
      // ordering: LinkLabelPicker's portal appends after the panel's
      // portal, so equal z-index leaves us on top.
      //
      // `pointerEvents: "auto"` is REQUIRED, not decorative: when the
      // picker is used inside the project detail modal (a Radix
      // Dialog with `modal={true}`), Radix's DismissableLayer sets
      // `document.body.style.pointerEvents = "none"` while the
      // dialog is open so clicks land only inside Dialog.Content.
      // This popover is portaled to <body> — a direct child of the
      // element with `pointer-events: none` — and `pointer-events`
      // inherits, so without this override every option button was
      // silently un-clickable inside the modal. See DismissableLayer
      // `disableOutsidePointerEvents` handling.
      //
      // We also stop mousedown / pointerdown propagation on the
      // popover surface so the same DismissableLayer doesn't treat a
      // click on an option as an "outside" interaction and dismiss
      // the parent Dialog before our onClick can fire — mirrors the
      // defence-in-depth added to MentionPicker's inline menu.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-[60] overflow-hidden rounded-md border border-wp-stone bg-white shadow-lg"
      style={{
        top: pos.top,
        left: pos.left,
        width: Math.max(pos.width, 200),
        maxHeight: pos.maxHeight,
        pointerEvents: "auto",
      }}
    >
      <div className="max-h-full overflow-y-auto py-1">
        {filtered.length === 0 && !canCreate ? (
          <p className="px-3 py-2 text-xs text-wp-slate">No matches.</p>
        ) : null}
        {filtered.map((o) => {
          const selected = o.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={o}
              type="button"
              onMouseDown={(e) => {
                // Prevent the input from blurring before we commit —
                // otherwise the outside-click handler runs first and
                // snaps `query` back to `value`, cancelling the pick.
                e.preventDefault();
              }}
              onClick={() => commit(o)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-wp-stone/40",
                selected ? "font-semibold text-wp-ink" : "text-wp-ink",
              )}
            >
              <span className="flex-1 truncate">{o}</span>
            </button>
          );
        })}
        {canCreate ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit(normalizedQuery)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-wp-red outline-none hover:bg-wp-red/5",
              filtered.length ? "border-t border-wp-stone/60" : "",
            )}
          >
            <Plus size={14} />
            <span className="flex-1 truncate">
              Create <span className="font-semibold">&lsquo;{normalizedQuery}&rsquo;</span>
            </span>
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div ref={wrapperRef} className={cn("relative", className)}>
        <input
          ref={inputRef}
          type="text"
          value={open ? query : value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          onFocus={() => {
            setOpen(true);
            // Show all options on focus (empty query) so the user can
            // pick a common label with two clicks; typing filters.
            setQuery("");
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // Prefer an exact case-insensitive match over the raw
              // typed string so pressing Enter on "jira" adopts the
              // canonical "Jira" casing when it exists.
              const match = options.find((o) => o.toLowerCase() === normalizedLower);
              if (match) commit(match);
              else if (normalizedQuery) commit(normalizedQuery);
            } else if (e.key === "ArrowDown" && !open) {
              setOpen(true);
            }
          }}
          className={cn(
            "w-full rounded-md border border-wp-stone bg-white px-2 py-1 pr-7 text-xs text-wp-ink",
            "focus:border-wp-red focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
        <ChevronDown
          size={12}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-wp-slate"
        />
      </div>
      {popover}
    </>
  );
}
