import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewKey = "board" | "roadmap";
export type ColorBy = "swim_lane" | "team" | "owner";
export type GroupBy = "none" | "owner" | "swim_lane" | "team" | "tag";

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

type Store = {
  board: PerView;
  roadmap: PerView;
  /**
   * Set of epic ids that are expanded on the Roadmap. Everything else
   * shows only the epic row; expanding reveals the full descendant
   * subtree indented under it. Stored as an array (not Set) so
   * zustand's `persist` can serialize it.
   */
  expandedEpicIds: string[];
  setFilters: (view: ViewKey, filters: FilterState) => void;
  setColorBy: (view: ViewKey, colorBy: ColorBy) => void;
  setGroupBy: (view: ViewKey, groupBy: GroupBy) => void;
  toggleEpicExpanded: (epicId: string) => void;
  expandAllEpics: (epicIds: string[]) => void;
  collapseAllEpics: () => void;
  clear: (view: ViewKey) => void;
};

// Defaults are per-view so the two surfaces can diverge without one
// forcing preferences on the other. Board doesn't render group
// headers, so its groupBy stays "none"; Roadmap defaults to "team"
// because that's the layout most PMs open it in.
const defaultBoardPerView: PerView   = { filters: emptyFilters, colorBy: "swim_lane", groupBy: "none" };
const defaultRoadmapPerView: PerView = { filters: emptyFilters, colorBy: "swim_lane", groupBy: "team" };

export const useViewStore = create<Store>()(
  persist(
    (set) => ({
      board: defaultBoardPerView,
      roadmap: defaultRoadmapPerView,
      expandedEpicIds: [],
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
      clear: (view) => set((s) => ({
        ...s,
        [view]: view === "board" ? defaultBoardPerView : defaultRoadmapPerView,
      })),
    }),
    {
      // Storage key intentionally kept from the previous shape
      // (product_area→team rename). Preference migrations flow
      // through `version` + `migrate` so users don't lose their
      // filter picks when a default changes.
      name: "waypoint.viewState.v2",
      version: 3,
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
        return persisted;
      },
    },
  ),
);
