import { useEffect, useRef, useState } from "react";

/**
 * Draggable bottom-edge handle for the Roadmap chart card. Same
 * contract as `ColumnResizer`, but vertical:
 *
 *   * `currentHeight` is the height the CARD should render at right
 *     now — the resizer never owns height state itself.
 *   * `onHeightChange` fires on every pointermove during a drag.
 *   * `onCommit` fires once on pointerup. Persistence lives above.
 *   * Escape / pointercancel reverts via `onCancel` and does not
 *     commit, so an aborted drag never overwrites the saved height.
 *
 * Visual: 1px hairline along the card's bottom border, thickening
 * to a 4px accent band on hover / during drag. Hitbox is taller
 * (12px) than the visible band so the target isn't a pixel-hunt.
 * Marked `data-pdf-exclude="true"` so it stays out of snapshots.
 */
type Props = {
  currentHeight: number;
  /** Read at pointer-down so the first drag can start from the
   *  CSS-computed height when the user has no persisted pick yet. */
  getStartHeight?: () => number;
  minHeight: number;
  maxHeight: number;
  onHeightChange: (px: number) => void;
  onCommit: (px: number) => void;
  onCancel: () => void;
  ariaLabel?: string;
};

type DragState = {
  startClientY: number;
  startHeight: number;
  pointerId: number;
  captureEl: HTMLElement;
};

export function HeightResizer({
  currentHeight,
  getStartHeight,
  minHeight,
  maxHeight,
  onHeightChange,
  onCommit,
  onCancel,
  ariaLabel,
}: Props) {
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      try { d.captureEl.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
      onCancel();
      dragRef.current = null;
      setDragging(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging, onCancel]);

  function clamp(px: number): number {
    return Math.max(minHeight, Math.min(maxHeight, Math.round(px)));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startHeight = getStartHeight?.() ?? currentHeight;
    dragRef.current = {
      startClientY: e.clientY,
      startHeight,
      pointerId: e.pointerId,
      captureEl: el,
    };
    setDragging(true);
    // Apply immediately so the card drops its CSS max-height cap
    // before the first pointermove (otherwise the cap fights growth).
    onHeightChange(startHeight);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.startClientY;
    onHeightChange(clamp(d.startHeight + dy));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    try { d.captureEl.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    const dy = e.clientY - d.startClientY;
    const next = clamp(d.startHeight + dy);
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
    onCancel();
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel ?? "Resize roadmap chart height"}
      aria-valuenow={currentHeight}
      aria-valuemin={minHeight}
      aria-valuemax={maxHeight}
      data-pdf-exclude="true"
      className="group absolute inset-x-0 bottom-0 z-30 h-3 cursor-ns-resize touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 transition-[background-color,height] duration-100 ${
          dragging
            ? "h-1 bg-wp-red/60"
            : "h-px bg-wp-stone group-hover:h-1 group-hover:bg-wp-red/50"
        }`}
      />
    </div>
  );
}
