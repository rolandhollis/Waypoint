import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewKey = "board" | "roadmap";
export type ColorBy = "swim_lane" | "product_area" | "owner";
export type GroupBy = "none" | "owner" | "swim_lane" | "product_area" | "tag";

export type FilterState = {
  ownerIds: string[];
  productAreaIds: string[];
  swimLaneIds: string[];
  tags: string[];
  dateFrom: string | null;
  dateTo: string | null;
  search: string;
};

export const emptyFilters: FilterState = {
  ownerIds: [], productAreaIds: [], swimLaneIds: [], tags: [],
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
  setFilters: (view: ViewKey, filters: FilterState) => void;
  setColorBy: (view: ViewKey, colorBy: ColorBy) => void;
  setGroupBy: (view: ViewKey, groupBy: GroupBy) => void;
  clear: (view: ViewKey) => void;
};

const defaultPerView: PerView = { filters: emptyFilters, colorBy: "swim_lane", groupBy: "none" };

export const useViewStore = create<Store>()(
  persist(
    (set) => ({
      board: defaultPerView,
      roadmap: defaultPerView,
      setFilters: (view, filters) => set((s) => ({ ...s, [view]: { ...s[view], filters } })),
      setColorBy: (view, colorBy) => set((s) => ({ ...s, [view]: { ...s[view], colorBy } })),
      setGroupBy: (view, groupBy) => set((s) => ({ ...s, [view]: { ...s[view], groupBy } })),
      clear: (view) => set((s) => ({ ...s, [view]: defaultPerView })),
    }),
    { name: "waypoint.viewState" },
  ),
);
