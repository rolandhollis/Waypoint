import { useEffect, useRef, type CSSProperties } from "react";

import { useViewStore } from "./viewState";

/**
 * Shared hook powering the "drag the bottom edge to resize" behavior
 * on the roadmap scroll card. Consumed by both the Rows renderer
 * (`GanttTimeline`, sticky-header branch) and the Compact renderer
 * (`RoadmapCompactView`) so the two views stay in lockstep on:
 *
 *   1. Applying the user's persisted height back to the DOM on mount
 *      via an inline `style={{ height }}` — this is what makes the
 *      picked height survive a reload.
 *   2. Observing subsequent height changes via a single
 *      `ResizeObserver` and writing them back to the persisted
 *      view store on a short debounce so a rapid drag doesn't hammer
 *      `localStorage`.
 *
 * `pdfMode` short-circuits both halves: the exporter needs the card
 * to render at its natural content height (no scroll, no scrollbar
 * chrome) and must never write to the persisted store from a
 * transient snapshot commit.
 *
 * The store setter itself clamps into
 * `[ROADMAP_HEIGHT_MIN_PX, ROADMAP_HEIGHT_MAX_PX]`, so no clamp is
 * needed here — the ResizeObserver already only observes valid
 * layout-computed heights (constrained by the class's `min-h` /
 * `max-h`), and the store defense-in-depth clamp catches anything
 * exotic that slips through.
 */
export function useResizableRoadmapHeight(opts: {
  /** Scroll-card element ref. Same ref the view uses for its own
   *  ResizeObserver / scroll-anchor bookkeeping — this hook adds a
   *  separate observer so it can key off height alone. */
  ref: React.RefObject<HTMLElement | null>;
  /** When true the hook is a no-op: no inline height, no observer,
   *  no writes. Matches the `pdfMode` gate the roadmap views use
   *  elsewhere for capture-safe rendering. */
  disabled: boolean;
}): { style: CSSProperties | undefined } {
  const { ref, disabled } = opts;
  const savedHeight = useViewStore((s) => s.roadmapHeightPx);
  const setHeight = useViewStore((s) => s.setRoadmapHeightPx);

  // Debounce timer for persist writes. Kept in a ref so consecutive
  // observer callbacks can clear + reschedule without racing state.
  const persistTimerRef = useRef<number | null>(null);
  // Track the last value we wrote (or read at mount) so the observer
  // doesn't re-persist an equal height. Prevents a feedback loop
  // where applying `savedHeight` → element mounts at that height →
  // observer fires → store write → re-render → new inline style →
  // observer fires again. Only a real user drag or window reflow
  // that changes the height above the min/max class caps produces a
  // different observed height.
  const lastPersistedRef = useRef<number | null>(savedHeight);

  useEffect(() => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const px = Math.round(entry.contentRect.height);
        // Ignore zero-height observations — happens once when the
        // element is hidden (e.g. during a pdfMode flush that
        // detaches the sticky-scroll subtree). Writing 0 would
        // clamp up to MIN_PX and reset the user's pick to the
        // minimum, which is not what they asked for.
        if (px <= 0) continue;
        if (lastPersistedRef.current === px) continue;
        if (persistTimerRef.current !== null) {
          window.clearTimeout(persistTimerRef.current);
        }
        persistTimerRef.current = window.setTimeout(() => {
          lastPersistedRef.current = px;
          setHeight(px);
          persistTimerRef.current = null;
        }, 200);
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [ref, disabled, setHeight]);

  // Keep the "already-persisted" mirror in sync with the store so a
  // cross-tab / manual store update doesn't cause an immediate
  // re-persist of the same value from the observer's next tick.
  useEffect(() => {
    lastPersistedRef.current = savedHeight;
  }, [savedHeight]);

  if (disabled) return { style: undefined };
  return {
    style: savedHeight != null ? { height: savedHeight } : undefined,
  };
}
