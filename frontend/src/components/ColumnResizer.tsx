import { useEffect, useRef, useState } from "react";

/**
 * Draggable vertical divider used between the Roadmap Gantt's label
 * column and its chart column so users can widen the label side to
 * read full project titles that would otherwise truncate.
 *
 * Contract with the parent:
 *   * `currentWidth` is the width the LABEL COLUMN should render at
 *     right now — the resizer never owns width state itself, it just
 *     reports pointer deltas back up via `onWidthChange`.
 *   * `onWidthChange` fires on every pointermove during a drag with
 *     the clamped candidate width, so the parent can re-render the
 *     column live. It's the parent's job to feed the same value back
 *     via `currentWidth` for the next frame.
 *   * `onCommit` fires exactly once per successful drag (on
 *     pointerup) with the final clamped width. Persistence
 *     (localStorage / zustand) lives above the resizer; separating
 *     "live" from "committed" keeps the persist middleware from
 *     writing 60 times per second during a drag.
 *   * Escape during a drag reverts to the pre-drag width via
 *     `onWidthChange` and does NOT call `onCommit`, so a cancelled
 *     drag never leaves an unwanted value behind. Same for
 *     pointercancel (touch interruption, another element grabbing
 *     capture, etc.).
 *
 * Visual: 1px hairline by default, thickens to a 4px accent band on
 * hover / during drag. Hitbox is wider (6px) than the visible band
 * so the resize target isn't a pixel-hunt. Marked
 * `data-pdf-exclude="true"` so it disappears from PDF snapshots —
 * the exported artefact reflects whatever column width the user has
 * saved, but the divider itself is chrome and shouldn't be printed.
 */
type Props = {
  currentWidth: number;
  minWidth: number;
  maxWidth: number;
  onWidthChange: (px: number) => void;
  onCommit: (px: number) => void;
  ariaLabel?: string;
};

type DragState = {
  startClientX: number;
  startWidth: number;
  pointerId: number;
  captureEl: HTMLElement;
};

export function ColumnResizer({
  currentWidth,
  minWidth,
  maxWidth,
  onWidthChange,
  onCommit,
  ariaLabel,
}: Props) {
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  // Escape aborts the drag and rewinds to the pre-drag width. Bound
  // at the window level so the user doesn't have to keep the pointer
  // over the divider to cancel — mid-drag they're often several
  // hundred pixels off to the side.
  useEffect(() => {
    if (!dragging) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      try { d.captureEl.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
      onWidthChange(d.startWidth);
      dragRef.current = null;
      setDragging(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging, onWidthChange]);

  function clamp(px: number): number {
    return Math.max(minWidth, Math.min(maxWidth, Math.round(px)));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // preventDefault so the browser doesn't kick off a text-selection
    // gesture on parent flex text — with pointer capture the browser
    // still tries to select if we don't stop the default here.
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      startClientX: e.clientX,
      startWidth: currentWidth,
      pointerId: e.pointerId,
      captureEl: el,
    };
    setDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startClientX;
    onWidthChange(clamp(d.startWidth + dx));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    try { d.captureEl.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    const dx = e.clientX - d.startClientX;
    const next = clamp(d.startWidth + dx);
    dragRef.current = null;
    setDragging(false);
    onCommit(next);
  }

  function handlePointerCancel() {
    const d = dragRef.current;
    if (!d) {
      setDragging(false);
      return;
    }
    // Revert to the pre-drag width — same semantics as Escape. The
    // OS took the pointer away (e.g. gesture recognizer, browser
    // tab-switch), so committing whatever the last onWidthChange was
    // would feel arbitrary.
    onWidthChange(d.startWidth);
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel ?? "Resize label column"}
      aria-valuenow={currentWidth}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      data-pdf-exclude="true"
      className="group relative w-1.5 shrink-0 cursor-col-resize touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[background-color,width] duration-100 ${
          dragging
            ? "w-1 bg-wp-red/60"
            : "w-px bg-wp-stone group-hover:w-1 group-hover:bg-wp-red/50"
        }`}
      />
    </div>
  );
}
