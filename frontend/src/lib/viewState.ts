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

/**
 * Persisted top-level tab in the Admin view. Keys map 1:1 with the
 * `TabKey`s that `AdminSettingsView.tsx` renders — kept as a wide
 * string here (rather than importing the union) so the store stays
 * independent of the admin view file.
 *
 * `null` means "no explicit pick yet — land on whatever the view's
 * default resolution is" (which today is the first tab visible to
 * the caller). Storing the pick lets a returning admin come back
 * to the same sub-panel they were last in even if they close and
 * reopen the tab.
 */
export type AdminTopTabKey =
  | "workspace"
  | "users"
  | "archived"
  | "notifications"
  | "tshirt-sizes"
  | "ai-reference-estimates"
  | "csv"
  | "constants";

/**
 * Persisted sub-tab pick for each parent that has sub-tabs. Keyed
 * by parent tab id so switching top-level tabs preserves the sub-
 * tab pick you left off on. Values are the free-form sub-tab id
 * strings that each parent's local render defines.
 */
export type AdminSubTabState = {
  workspace?: string;
  csv?: string;
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
  /**
   * User-controlled width (in CSS px) of the Roadmap Gantt's left
   * label column. The column has a draggable divider on its right
   * edge; on pointer-up we clamp against
   * `[ROADMAP_LABEL_COLUMN_MIN_PX, ROADMAP_LABEL_COLUMN_MAX_PX]` and
   * persist the result here so widening the column to read long
   * project titles survives a reload. Also honored by the PDF
   * exporter, which snapshots whatever the interactive view is
   * currently showing.
   */
  roadmapLabelColumnPx: number;
  /**
   * Persisted Admin-view tab state. `adminActiveTab` is the currently
   * open top-level tab (or `null` = "no explicit pick yet — fall back
   * to whatever the URL / default resolution picks"). `adminSubTabs`
   * carries the currently open sub-tab per parent so switching parents
   * remembers where each was.
   *
   * The URL `?tab=` / `?subtab=` params remain the canonical live
   * source of truth (so admin URLs stay deep-linkable); this store
   * mirrors the pick so a returning admin without a URL lands where
   * they left off.
   */
  adminActiveTab: AdminTopTabKey | null;
  adminSubTabs: AdminSubTabState;
  setFilters: (view: ViewKey, filters: FilterState) => void;
  setColorBy: (view: ViewKey, colorBy: ColorBy) => void;
  setGroupBy: (view: ViewKey, groupBy: GroupBy) => void;
  toggleEpicExpanded: (epicId: string) => void;
  expandAllEpics: (epicIds: string[]) => void;
  collapseAllEpics: () => void;
  setRoadmapRecentChangesOpen: (v: boolean) => void;
  setRoadmapUnscheduledOpen: (v: boolean) => void;
  setRoadmapLabelColumnPx: (px: number) => void;
  setAdminActiveTab: (key: AdminTopTabKey) => void;
  setAdminSubTab: (parent: keyof AdminSubTabState, key: string) => void;
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

/**
 * Bounds for the Roadmap Gantt's left label column.
 *
 * `MIN_PX` keeps the epic chevron + type icon + a couple of characters
 * of the title always visible so the column never collapses to an
 * unreadable strip. `MAX_PX` caps at roughly two-thirds of a typical
 * 1440px monitor's usable width so the chart itself can't be squeezed
 * to nothing on narrow layouts. `DEFAULT_PX` matches the pre-resizer
 * fixed width, so returning users without a persisted preference land
 * on the same layout they had before the divider was introduced.
 */
export const ROADMAP_LABEL_COLUMN_MIN_PX = 120;
export const ROADMAP_LABEL_COLUMN_MAX_PX = 640;
export const ROADMAP_LABEL_COLUMN_DEFAULT_PX = 260;

function clampRoadmapLabelColumnPx(px: number): number {
  if (!Number.isFinite(px)) return ROADMAP_LABEL_COLUMN_DEFAULT_PX;
  return Math.max(
    ROADMAP_LABEL_COLUMN_MIN_PX,
    Math.min(ROADMAP_LABEL_COLUMN_MAX_PX, Math.round(px)),
  );
}

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
      roadmapLabelColumnPx: ROADMAP_LABEL_COLUMN_DEFAULT_PX,
      // Admin tab state starts empty so the view falls back to its
      // "first visible tab" default until the user actually picks
      // one (which persists via setAdminActiveTab below).
      adminActiveTab: null,
      adminSubTabs: {},
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
      // Always run picked widths through the clamp so a caller that
      // passes an unclamped delta from a pointer event can't wedge
      // the store into an unreachable state (e.g. 8000px from a
      // stuck drag). Escape / cancel paths in the resizer restore
      // the pre-drag value directly, which is also inside the range
      // by construction.
      setRoadmapLabelColumnPx: (px) =>
        set(() => ({ roadmapLabelColumnPx: clampRoadmapLabelColumnPx(px) })),
      setAdminActiveTab: (key) => set(() => ({ adminActiveTab: key })),
      setAdminSubTab: (parent, key) =>
        set((s) => ({ adminSubTabs: { ...s.adminSubTabs, [parent]: key } })),
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
      version: 8,
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
        // < v7: added the roadmap left-label-column resize preference.
        // Backfill the default so returning users land on the same
        // pre-resizer layout; also clamp any pre-existing value to the
        // supported range in case a future migration writes it before
        // the version bump.
        if (version < 7 || typeof persisted.roadmapLabelColumnPx !== "number") {
          persisted.roadmapLabelColumnPx = ROADMAP_LABEL_COLUMN_DEFAULT_PX;
        } else {
          persisted.roadmapLabelColumnPx = clampRoadmapLabelColumnPx(
            persisted.roadmapLabelColumnPx,
          );
        }
        // < v8: added persisted Admin tab / sub-tab picks. Default
        // both to their "no pick yet" values so returning admins fall
        // back to whatever the current default resolution picks —
        // exactly the same landing state a fresh user gets. The URL
        // `?tab=` / `?subtab=` params still take precedence when
        // present.
        if (version < 8) {
          if (persisted.adminActiveTab === undefined) {
            persisted.adminActiveTab = null;
          }
          if (!persisted.adminSubTabs || typeof persisted.adminSubTabs !== "object") {
            persisted.adminSubTabs = {};
          }
        }
        return persisted;
      },
    },
  ),
);
