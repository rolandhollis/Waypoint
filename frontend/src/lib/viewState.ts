import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewKey = "board" | "roadmap" | "ezestimates";
export type ColorBy = "swim_lane" | "team" | "owner";
export type GroupBy = "none" | "owner" | "swim_lane" | "team" | "tag" | "kpi";

export type FilterState = {
  ownerIds: string[];
  teamIds: string[];
  swimLaneIds: string[];
  tags: string[];
  dateFrom: string | null;
  dateTo: string | null;
  search: string;
};

export const emptyFilters: FilterState = {
  ownerIds: [], teamIds: [], swimLaneIds: [], tags: [],
  dateFrom: null, dateTo: null, search: "",
};

type PerView = {
  filters: FilterState;
  colorBy: ColorBy;
  groupBy: GroupBy;
};

/**
 * EZEstimates-only extras layered on top of the shared PerView
 * shape. Two additional filter dropdowns live on that view (created
 * within N days, and dev-estimate sourced-by-dev = yes/no/any) and
 * their picks are persisted alongside the standard filter/colorBy/
 * groupBy trio so a returning PM lands back in the same slice.
 */
export type EzestimatesPerView = PerView & {
  /** null = "All time"; otherwise the max age (in days) of a project's
   *  created_at that keeps it visible. */
  createdWithinDays: 7 | 14 | 30 | null;
  /** "any" = filter off. "yes" = only projects with
   *  dev_estimate_sourced_by_dev === true; "no" = only === false. */
  devSourced: "any" | "yes" | "no";
};

type Store = {
  board: PerView;
  roadmap: PerView;
  ezestimates: EzestimatesPerView;
  /**
   * Set of epic ids that are expanded on the Roadmap. Everything else
   * shows only the epic row; expanding reveals the full descendant
   * subtree indented under it. Stored as an array (not Set) so
   * zustand's `persist` can serialize it.
   */
  expandedEpicIds: string[];
  /**
   * Whether the Roadmap "Recent changes" and "Unscheduled" sections
   * are expanded. These are shared page-level UI prefs (not tied to
   * any specific PerView slot) that persist per browser so the user's
   * "keep the panel closed" preference survives a reload.
   */
  roadmapRecentChangesOpen: boolean;
  roadmapUnscheduledOpen: boolean;
  setFilters: (view: ViewKey, filters: FilterState) => void;
  setColorBy: (view: ViewKey, colorBy: ColorBy) => void;
  setGroupBy: (view: ViewKey, groupBy: GroupBy) => void;
  toggleEpicExpanded: (epicId: string) => void;
  expandAllEpics: (epicIds: string[]) => void;
  collapseAllEpics: () => void;
  setRoadmapRecentChangesOpen: (v: boolean) => void;
  setRoadmapUnscheduledOpen: (v: boolean) => void;
  /** EZEstimates-only "Created" dropdown. Null clears the filter
   *  (i.e. "All time"); the three discrete allowed values are the
   *  only ones surfaced in the UI. */
  setEzestimatesCreatedWithinDays: (v: 7 | 14 | 30 | null) => void;
  /** EZEstimates-only "Dev-sourced" dropdown. */
  setEzestimatesDevSourced: (v: "any" | "yes" | "no") => void;
  clear: (view: ViewKey) => void;
};

// Defaults are per-view so the two surfaces can diverge without one
// forcing preferences on the other. Board doesn't render group
// headers, so its groupBy stays "none"; Roadmap defaults to "team"
// because that's the layout most PMs open it in.
const defaultBoardPerView: PerView   = { filters: emptyFilters, colorBy: "swim_lane", groupBy: "none" };
const defaultRoadmapPerView: PerView = { filters: emptyFilters, colorBy: "swim_lane", groupBy: "team" };
// EZEstimates is a flat, sizing-focused table — the color-by /
// group-by controls aren't rendered there, so the defaults are just
// filler that the FilterBar never surfaces to the user. The two
// EZEstimates-only extras (createdWithinDays, devSourced) default
// to their "no filter applied" values so a first-time visit shows
// every eligible project.
const defaultEzestimatesPerView: EzestimatesPerView = {
  filters: emptyFilters,
  colorBy: "swim_lane",
  groupBy: "none",
  createdWithinDays: null,
  devSourced: "any",
};

export const useViewStore = create<Store>()(
  persist(
    (set) => ({
      board: defaultBoardPerView,
      roadmap: defaultRoadmapPerView,
      ezestimates: defaultEzestimatesPerView,
      expandedEpicIds: [],
      // Both Roadmap page-level panels start collapsed — they're
      // "peek in when you need it" surfaces, not the primary content.
      roadmapRecentChangesOpen: false,
      roadmapUnscheduledOpen: false,
      setFilters: (view, filters) => set((s) => ({ ...s, [view]: { ...s[view], filters } })),
      setColorBy: (view, colorBy) => set((s) => ({ ...s, [view]: { ...s[view], colorBy } })),
      setGroupBy: (view, groupBy) => set((s) => ({ ...s, [view]: { ...s[view], groupBy } })),
      toggleEpicExpanded: (epicId) => set((s) => {
        const has = s.expandedEpicIds.includes(epicId);
        return { expandedEpicIds: has
          ? s.expandedEpicIds.filter((id) => id !== epicId)
          : [...s.expandedEpicIds, epicId] };
      }),
      expandAllEpics: (epicIds) => set(() => ({ expandedEpicIds: [...epicIds] })),
      collapseAllEpics: () => set(() => ({ expandedEpicIds: [] })),
      setRoadmapRecentChangesOpen: (v) => set(() => ({ roadmapRecentChangesOpen: v })),
      setRoadmapUnscheduledOpen: (v) => set(() => ({ roadmapUnscheduledOpen: v })),
      setEzestimatesCreatedWithinDays: (v) =>
        set((s) => ({ ...s, ezestimates: { ...s.ezestimates, createdWithinDays: v } })),
      setEzestimatesDevSourced: (v) =>
        set((s) => ({ ...s, ezestimates: { ...s.ezestimates, devSourced: v } })),
      clear: (view) => set((s) => ({
        ...s,
        [view]:
          view === "board"
            ? defaultBoardPerView
            : view === "roadmap"
            ? defaultRoadmapPerView
            : defaultEzestimatesPerView,
      })),
    }),
    {
      // Storage key intentionally kept from the previous shape
      // (product_area→team rename). Preference migrations flow
      // through `version` + `migrate` so users don't lose their
      // filter picks when a default changes.
      name: "waypoint.viewState.v2",
      version: 6,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrate: (persisted: any, version: number): any => {
        if (!persisted || typeof persisted !== "object") return persisted;
        // < v2: Roadmap's default groupBy moved from "none" to
        // "team". Only bump users who never actively changed it;
        // any custom pick stays intact.
        if (version < 2 && persisted.roadmap?.groupBy === "none") {
          persisted.roadmap = { ...persisted.roadmap, groupBy: "team" };
        }
        // < v3: added expandedEpicIds. Default to collapsed for a
        // clean landing view — epics-only is the requested norm.
        if (version < 3 && !Array.isArray(persisted.expandedEpicIds)) {
          persisted.expandedEpicIds = [];
        }
        // < v4: added the EZEstimates view. Backfill its per-view
        // slot so `useViewStore((s) => s.ezestimates.filters)` on a
        // returning user doesn't blow up on undefined.
        if (version < 4 && !persisted.ezestimates) {
          persisted.ezestimates = defaultEzestimatesPerView;
        }
        // < v5: added roadmap page-level section-open prefs. Default
        // both to false (collapsed) if the persisted payload predates
        // them so returning users get the same "closed on load"
        // landing state as fresh users.
        if (version < 5) {
          if (typeof persisted.roadmapRecentChangesOpen !== "boolean") {
            persisted.roadmapRecentChangesOpen = false;
          }
          if (typeof persisted.roadmapUnscheduledOpen !== "boolean") {
            persisted.roadmapUnscheduledOpen = false;
          }
        }
        // < v6: added the EZEstimates-only createdWithinDays +
        // devSourced dropdowns. Backfill defaults ("no filter") so
        // returning users see every eligible project on first load.
        if (version < 6 && persisted.ezestimates) {
          if (persisted.ezestimates.createdWithinDays === undefined) {
            persisted.ezestimates.createdWithinDays = null;
          }
          if (typeof persisted.ezestimates.devSourced !== "string") {
            persisted.ezestimates.devSourced = "any";
          }
        }
        return persisted;
      },
    },
  ),
);
