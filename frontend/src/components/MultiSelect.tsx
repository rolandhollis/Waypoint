import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

export type MultiSelectOption = { id: string; label: string };

/**
 * Multi-select popover with an internal scroll list, shared by the
 * top-level FilterBar and any surface (e.g. the Prioritization
 * finder panel) that needs a compact "chip button opens a checkbox
 * list" affordance.
 *
 * The popover is rendered via a portal into <body> with `position:
 * fixed`, anchored to the trigger's bounding rect. This mirrors
 * the FilterBar's original inline implementation: an earlier
 * `<details>` + `absolute` implementation was clipped on the
 * Roadmap tab because the RoadmapView root uses `overflow-hidden`
 * (needed for the horizontal Gantt scroller), and an absolutely-
 * positioned descendant whose containing block sits inside an
 * overflow-hidden ancestor gets clipped at that ancestor's border
 * box — so the popover's internal scroll gutter lost its bottom
 * rows.
 *
 * Portalling to <body> and using `position: fixed` puts the popover
 * outside every ancestor's overflow/stacking context, so it never
 * gets clipped or painted-under regardless of which view hosts it.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  emptyMessage,
  widthClass,
}: {
  label: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (v: string[]) => void;
  /** Copy shown when `options` is empty. Defaults to "None available". */
  emptyMessage?: string;
  /** Override the popover width. Defaults to `w-56`. */
  widthClass?: string;
}) {
  const selected = new Set(value);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  // Recompute the popover's fixed-position coordinates whenever it
  // opens, on scroll, and on resize. Kept in a layout effect so the
  // first paint after `open` flips already has the correct top/left
  // — otherwise there's a one-frame flash at (0,0).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const GAP = 4;
      const VIEWPORT_MARGIN = 8;
      const spaceBelow = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      const maxHeight = Math.max(160, Math.min(256, spaceBelow));
      setPos({ top: rect.bottom + GAP, left: rect.left, maxHeight });
    }
    place();
    window.addEventListener("resize", place);
    // `true` so we catch scrolls in ANY scroll container between the
    // trigger and the viewport (the RoadmapView root, main, etc.),
    // not just the window itself.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Close on outside pointerdown / Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const popover = open && pos ? createPortal(
    <div
      ref={popoverRef}
      className={cn(
        "fixed z-40 overflow-y-auto rounded-md border border-wp-stone bg-white p-1 shadow-md",
        widthClass ?? "w-56",
      )}
      style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
    >
      {options.length === 0 ? (
        <div className="px-2 py-1 text-xs text-wp-slate">{emptyMessage ?? "None available"}</div>
      ) : null}
      {options.map((o) => (
        <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-wp-stone/40">
          <input
            type="checkbox"
            checked={selected.has(o.id)}
            onChange={() => {
              const next = new Set(selected);
              if (next.has(o.id)) next.delete(o.id); else next.add(o.id);
              onChange(Array.from(next));
            }}
          />
          <span className="truncate text-wp-ink">{o.label}</span>
        </label>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "cursor-pointer select-none rounded-md border border-wp-stone bg-white px-2.5 py-1.5 text-xs text-wp-slate",
          value.length ? "text-wp-ink" : "",
        )}
      >
        {label}{value.length ? ` · ${value.length}` : ""}
      </button>
      {popover}
    </>
  );
}
