import { useCallback, useState, type CSSProperties } from "react";

import {
  ROADMAP_HEIGHT_MAX_PX,
  ROADMAP_HEIGHT_MIN_PX,
  useViewStore,
} from "./viewState";

/**
 * Shared hook powering the "drag the bottom edge to resize" behavior
 * on the roadmap scroll card. Consumed by both the Rows renderer
 * (`GanttTimeline`, sticky-header branch) and the Compact renderer
 * (`RoadmapCompactView`) so the two views stay in lockstep on:
 *
 *   1. Applying the user's persisted height back to the DOM on mount
 *      via an inline `style={{ height }}` — this is what makes the
 *      picked height survive a reload.
 *   2. Live height during a `HeightResizer` drag (local state, not
 *      persisted) and a single store write on commit so a rapid drag
 *      doesn't hammer `localStorage`.
 *
 * `pdfMode` short-circuits both halves: the exporter needs the card
 * to render at its natural content height (no scroll, no scrollbar
 * chrome) and must never write to the persisted store from a
 * transient snapshot commit.
 *
 * The store setter itself clamps into
 * `[ROADMAP_HEIGHT_MIN_PX, ROADMAP_HEIGHT_MAX_PX]`.
 */
export function useResizableRoadmapHeight(opts: {
  /** Scroll-card element ref — used to measure the CSS-computed
   *  height on the first drag when the user has no persisted pick. */
  ref: React.RefObject<HTMLElement | null>;
  /** When true the hook is a no-op: no inline height, no writes.
   *  Matches the `pdfMode` / monolithic gate the roadmap views use
   *  for capture-safe rendering. */
  disabled: boolean;
}): {
  style: CSSProperties | undefined;
  height: number;
  hasExplicitHeight: boolean;
  minHeight: number;
  maxHeight: number;
  getStartHeight: () => number;
  onHeightChange: (px: number) => void;
  onCommit: (px: number) => void;
  onCancel: () => void;
} {
  const { ref, disabled } = opts;
  const savedHeight = useViewStore((s) => s.roadmapHeightPx);
  const setHeight = useViewStore((s) => s.setRoadmapHeightPx);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);

  const measure = useCallback((): number => {
    const el = ref.current;
    if (el) {
      const px = Math.round(el.getBoundingClientRect().height);
      if (px > 0) return px;
    }
    return ROADMAP_HEIGHT_MIN_PX;
  }, [ref]);

  const getStartHeight = useCallback((): number => {
    if (liveHeight != null) return liveHeight;
    if (savedHeight != null) return savedHeight;
    return measure();
  }, [liveHeight, savedHeight, measure]);

  const height = liveHeight ?? savedHeight ?? ROADMAP_HEIGHT_MIN_PX;
  const hasExplicitHeight = !disabled && (liveHeight != null || savedHeight != null);

  const onHeightChange = useCallback((px: number) => {
    setLiveHeight(px);
  }, []);

  const onCommit = useCallback((px: number) => {
    setLiveHeight(null);
    setHeight(px);
  }, [setHeight]);

  const onCancel = useCallback(() => {
    setLiveHeight(null);
  }, []);

  if (disabled) {
    return {
      style: undefined,
      height: ROADMAP_HEIGHT_MIN_PX,
      hasExplicitHeight: false,
      minHeight: ROADMAP_HEIGHT_MIN_PX,
      maxHeight: ROADMAP_HEIGHT_MAX_PX,
      getStartHeight,
      onHeightChange,
      onCommit,
      onCancel,
    };
  }

  return {
    style: hasExplicitHeight ? { height } : undefined,
    height,
    hasExplicitHeight,
    minHeight: ROADMAP_HEIGHT_MIN_PX,
    maxHeight: ROADMAP_HEIGHT_MAX_PX,
    getStartHeight,
    onHeightChange,
    onCommit,
    onCancel,
  };
}
