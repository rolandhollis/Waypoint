import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Consistent expand/collapse wrapper used everywhere a chevron toggles
 * inline content into view.
 *
 * Animates height between 0 and the child's natural height via the modern
 * CSS grid `grid-template-rows: 0fr | 1fr` trick — no JS measurement, no
 * scroll-height flicker, and layout-thrash-free for large children.
 *
 * The wrapper renders NO visible chrome (no padding, border, background):
 * it's transparent and the caller keeps whatever inline styling it had
 * before. All that changes is that content slides open/closed with a
 * short ease-out rather than snapping in and out of the DOM.
 *
 * Respects `prefers-reduced-motion: reduce` via the `motion-reduce:`
 * Tailwind variant — those users get an instant snap.
 */
export function Collapsible({
  open,
  children,
  duration = 180,
  className,
}: {
  /** Whether the content is visible. */
  open: boolean;
  /** The content to reveal / hide. */
  children: ReactNode;
  /**
   * Optional transition duration in ms. Defaults to 180ms — snappy but
   * still readable. Bump this for heavy content that benefits from a
   * slower reveal.
   */
  duration?: number;
  /** Optional class list applied to the outer wrapper. */
  className?: string;
}) {
  // Inline style rather than a Tailwind arbitrary duration so callers
  // can pass any number (Tailwind's JIT wouldn't pre-generate class
  // names for one-off values passed at runtime).
  const style: CSSProperties = {
    transitionDuration: `${duration}ms`,
  };
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      style={style}
    >
      {/* Inner clip: essential — the outer grid animates the ROW size
          between 0fr and 1fr, but the child would still paint outside
          that row without an overflow-hidden guard, which would
          eliminate the entire visual effect. `min-h-0` is required
          on the inner element for the row to actually shrink; without
          it, the child's intrinsic min-content height wins and the
          animation degenerates into an instant snap. */}
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
