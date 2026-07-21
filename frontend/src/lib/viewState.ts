import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { RoadmapHeadlineCacheEntry } from "./types";

export type ViewKey = "board" | "roadmap" | "ezestimates";
export type ColorBy = "swim_lane" | "team" | "owner";
export type GroupBy = "none" | "owner" | "swim_lane" | "team" | "tag" | "kpi";
/**
 * Roadmap row ordering mode. `startDate` (default) sorts each group
 * chronologically by the earliest phase start date; `priority` uses
 * the same swim-lane × per-lane rank the Board view drives, so a
 * drag-reorder in this mode persists globally via the existing
 * per-lane reorder endpoint. `startDate` allows a purely view-local
 * "custom order" override per group (see roadmapOverrideByGroup).
 */
export type RoadmapSort = "startDate" | "priority";

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
   * How Roadmap rows are ordered within each group (or across the
   * chart when `groupBy === "none"`). Default is `"startDate"`,
   * which is the chronological byStart sort the chart has always
   * used. `"priority"` uses the composite (swim_lane.order,
   * projects.position, updated_at desc, id) rank driven by the
   * Board view; dragging a row in this mode fires the same
   * per-lane reorder endpoint the Board uses so the change is
   * globally persisted.
   */
  roadmapSort: RoadmapSort;
  /**
   * Per-group "custom order" overrides used ONLY when
   * `roadmapSort === "startDate"`. Keys are the group keys that
   * GanttTimeline emits (`"all"` for ungrouped, or the group id /
   * `"__unassigned"` bucket key when grouped). Values are ordered
   * arrays of top-level project ids representing the user's manual
   * ordering. Items that appear in a group but are missing from
   * the override array fall to the end of the list in their
   * natural chronological order.
   *
   * Overrides are wholly cleared whenever the user toggles the
   * Sort by control (either direction) so switching modes always
   * lands on the canonical order for that mode.
   */
  roadmapOverrideByGroup: Record<string, string[]>;
  /**
   * Roadmap-only "Show conflicts" toggle. Default `true` so a fresh
   * or migrated user lands on the historical view where every
   * capacity / deadline / dependency indicator is visible. When
   * flipped off, GanttTimeline suppresses the amber / red conflict
   * visuals (row overload overlays, group overload overlays, the
   * top-axis "any overload" strip + icons, the deadline-alert
   * triangle icon, the dependency-alert broken-chain icon, and the
   * violated-color variants of dependency arrows / tick marks /
   * per-phase chain icons) — the informational styling stays so
   * dotted dep lines and tick marks are still visible as wayfinding
   * aids. The PDF exporter captures whatever the current toggle
   * state produces without a separate flag because the DOM already
   * reflects it. Persisted per-browser via zustand persist so a
   * returning PM lands back on their preferred display.
   */
  showConflicts: boolean;
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
  /**
   * Client-side cache for the AI Roadmap Headline feature. Keyed
   * by tenant (group) id so headlines never leak across tenants
   * when a user switches groups from the navbar. Each entry
   * carries the fingerprint that produced it so the UI can detect
   * "filters changed since this summary was generated" without
   * hitting the server.
   *
   * Deliberately client-only: the backend endpoint never persists.
   * A stale cache from a group that no longer exists is harmless
   * (it just sits until the user clears local storage).
   */
  roadmapHeadline: {
    byGroupId: Record<string, RoadmapHeadlineCacheEntry>;
  };
  setFilters: (view: ViewKey, filters: FilterState) => void;
  setColorBy: (view: ViewKey, colorBy: ColorBy) => void;
  setGroupBy: (view: ViewKey, groupBy: GroupBy) => void;
  toggleEpicExpanded: (epicId: string) => void;
  expandAllEpics: (epicIds: string[]) => void;
  collapseAllEpics: () => void;
  setRoadmapRecentChangesOpen: (v: boolean) => void;
  setRoadmapUnscheduledOpen: (v: boolean) => void;
  setRoadmapLabelColumnPx: (px: number) => void;
  /**
   * Set the Roadmap sort mode. Always clears every per-group
   * override — switching modes should never leave a stale
   * "Custom order" indicator from the other mode. Clicking the
   * currently-active mode also clears overrides (that's the reset
   * affordance for the Start-date mode's Custom-order chip).
   */
  setRoadmapSort: (sort: RoadmapSort) => void;
  /**
   * Overwrite the per-group override list for a single group.
   * Pass an empty array (or omit / null) to clear the entry.
   * Only meaningful when `roadmapSort === "startDate"`; the
   * Priority mode ignores the override map entirely.
   */
  setRoadmapOverride: (groupKey: string, orderedIds: string[] | null) => void;
  /**
   * Discard every per-group override in one call. Used by the
   * "Custom order · Reset" chip and by the sort-mode toggle.
   */
  clearRoadmapOverrides: () => void;
  /**
   * Toggle for the Roadmap "Show conflicts" checkbox. Purely a view
   * preference — never touches backend state or violation
   * computation, only whether the resulting visuals paint.
   */
  setShowConflicts: (v: boolean) => void;
  setAdminActiveTab: (key: AdminTopTabKey) => void;
  setAdminSubTab: (parent: keyof AdminSubTabState, key: string) => void;
  /** EZEstimates-only "Created" dropdown. Null clears the filter
   *  (i.e. "All time"); the three discrete allowed values are the
   *  only ones surfaced in the UI. */
  setEzestimatesCreatedWithinDays: (v: 7 | 14 | 30 | null) => void;
  /** EZEstimates-only "Dev-sourced" dropdown. */
  setEzestimatesDevSourced: (v: "any" | "yes" | "no") => void;
  /**
   * Overwrite the AI Roadmap Headline cache for a specific tenant.
   * `null` clears the entry entirely — used when a user explicitly
   * discards a stale summary.
   */
  setRoadmapHeadline: (groupId: string, entry: RoadmapHeadlineCacheEntry | null) => void;
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
      roadmapSort: "startDate",
      roadmapOverrideByGroup: {},
      // Default the Show-conflicts toggle to on so a first-time
      // visit (or a returning user pre-migration) sees the full
      // set of capacity / deadline / dependency indicators the
      // roadmap has always rendered. Users who prefer the clean-
      // presentation mode opt in explicitly via the checkbox.
      showConflicts: true,
      // Admin tab state starts empty so the view falls back to its
      // "first visible tab" default until the user actually picks
      // one (which persists via setAdminActiveTab below).
      adminActiveTab: null,
      adminSubTabs: {},
      // Empty per-tenant cache on first mount. Entries are only
      // ever populated by an explicit user-driven Generate; nothing
      // in the app auto-fills this on load.
      roadmapHeadline: { byGroupId: {} },
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
      // Any sort-mode change (including re-picking the same mode)
      // wipes every per-group override so a stale "Custom order"
      // chip from the previous mode can't linger. The Start-date
      // → Start-date case is the reset affordance surfaced by the
      // Custom-order chip's × button; the Priority case matches
      // the spec ("Switching to Priority also clears the per-group
      // overrides since priority is a persistent global sort").
      //
      // The two-field update spreads `...s` explicitly so subscribers
      // to either slice re-render, even if a future zustand update
      // ever tweaks how partial-merges detect changes on functional
      // set. Without this, a returning user landing in Priority with
      // stale persisted overrides from a v10 session would have
      // watched Start-date clicks appear to do nothing because the
      // override map wasn't visibly wiped in the same tick as the
      // mode flip.
      setRoadmapSort: (sort) =>
        set((s) => ({ ...s, roadmapSort: sort, roadmapOverrideByGroup: {} })),
      // Defense in depth: even though the drag-end handler is
      // gated on `sortMode === "startDate"` before ever calling
      // this setter, the store itself rejects writes coming in
      // while the roadmap is in Priority mode. That way a future
      // code path (or a stray call from a stale closure captured
      // mid sort-toggle) can't leak Priority-mode drag data into
      // the Start-date override map — which was the exact class
      // of failure that made "click Start date" appear to do
      // nothing (a stale override kept the list stuck in the
      // priority order).
      setRoadmapOverride: (groupKey, orderedIds) =>
        set((s) => {
          if (s.roadmapSort !== "startDate") return s;
          const next = { ...s.roadmapOverrideByGroup };
          if (!orderedIds || orderedIds.length === 0) {
            delete next[groupKey];
          } else {
            next[groupKey] = orderedIds;
          }
          return { roadmapOverrideByGroup: next };
        }),
      clearRoadmapOverrides: () =>
        set((s) => ({ ...s, roadmapOverrideByGroup: {} })),
      setShowConflicts: (v) => set(() => ({ showConflicts: v })),
      setAdminActiveTab: (key) => set(() => ({ adminActiveTab: key })),
      setAdminSubTab: (parent, key) =>
        set((s) => ({ adminSubTabs: { ...s.adminSubTabs, [parent]: key } })),
      setEzestimatesCreatedWithinDays: (v) =>
        set((s) => ({ ...s, ezestimates: { ...s.ezestimates, createdWithinDays: v } })),
      setEzestimatesDevSourced: (v) =>
        set((s) => ({ ...s, ezestimates: { ...s.ezestimates, devSourced: v } })),
      setRoadmapHeadline: (groupId, entry) =>
        set((s) => {
          const next = { ...s.roadmapHeadline.byGroupId };
          if (entry === null) {
            delete next[groupId];
          } else {
            next[groupId] = entry;
          }
          return { roadmapHeadline: { byGroupId: next } };
        }),
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
      version: 11,
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
        // < v9: added the AI Roadmap Headline client cache. Backfill
        // an empty per-tenant map so returning users start fresh —
        // there's nothing to migrate FROM since this is a net-new
        // feature that never lived on any earlier version.
        if (version < 9) {
          if (
            !persisted.roadmapHeadline ||
            typeof persisted.roadmapHeadline !== "object" ||
            !persisted.roadmapHeadline.byGroupId ||
            typeof persisted.roadmapHeadline.byGroupId !== "object"
          ) {
            persisted.roadmapHeadline = { byGroupId: {} };
          }
        }
        // < v10: added the Roadmap Sort-by control + per-group
        // custom-order overrides. Default to the pre-feature
        // behavior ("startDate" with no overrides) so returning
        // users see the same chronological Gantt they had before
        // and only opt in to priority-sort / manual reordering by
        // clicking the new controls.
        if (version < 10) {
          if (persisted.roadmapSort !== "startDate" && persisted.roadmapSort !== "priority") {
            persisted.roadmapSort = "startDate";
          }
          if (
            !persisted.roadmapOverrideByGroup ||
            typeof persisted.roadmapOverrideByGroup !== "object"
          ) {
            persisted.roadmapOverrideByGroup = {};
          }
        }
        // < v11: added the Roadmap "Show conflicts" checkbox. Default
        // returning users to `true` so the migration is a no-op
        // visually — they see the exact same warning surface they had
        // before the toggle landed, and only opt in to the clean
        // presentation by unchecking the new control.
        if (version < 11 && typeof persisted.showConflicts !== "boolean") {
          persisted.showConflicts = true;
        }
        return persisted;
      },
    },
  ),
);
