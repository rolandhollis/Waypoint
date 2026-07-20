import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FileDown, Wand2 } from "lucide-react";
import { useCanWrite, useProjects, useRecentAuditEvents, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { applyFilters } from "../lib/filtering";
import { useViewStore } from "../lib/viewState";
import { computePhases } from "../lib/phaseCompute";
import { indexById } from "../lib/hierarchy";
import { isProjectInRoadmapViewport, type Zoom } from "../lib/roadmapViewport";
import { FilterBar } from "../components/FilterBar";
import { GanttTimeline } from "../components/GanttTimeline";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { RecentChanges } from "../components/RecentChanges";
import { UnscheduledList } from "../components/UnscheduledList";
import { PhaseLegend } from "../components/PhaseLegend";
import { ColorLegend } from "../components/ColorLegend";
import { RoadmapHelper } from "../components/RoadmapHelper";

export function RoadmapView() {
  const projects = useProjects();
  const lanes = useSwimLanes();
  const teams = useTeams();
  const users = useUsers();
  // Recent-changes feed for the section below the Gantt. Fetched at
  // the view level (not inside <RecentChanges />) so the query stays
  // active across section-collapse and doesn't restart on toggle;
  // 7-day window is the roadmap default. Kept above any early return
  // per the hook-order rule the previous blank-screen bug landed us
  // on (commit 21de7b1).
  const recentChanges = useRecentAuditEvents(7);
  const filters = useViewStore((s) => s.roadmap.filters);
  const colorBy = useViewStore((s) => s.roadmap.colorBy);
  const groupBy = useViewStore((s) => s.roadmap.groupBy);
  // Roadmap Gantt's left label column width is user-controlled via
  // a divider between the label and chart columns. The persisted
  // value lives in the zustand store (survives reloads); we mirror
  // it into local state during a drag so the resizer can update the
  // layout at pointer-frame cadence without hammering the persist
  // middleware once per pixel. On drag commit, `persistLabelColumnPx`
  // writes the final clamped value back to the store; an aborted
  // drag (Escape / pointercancel) rewinds the local state to the
  // pre-drag width without touching the store.
  const persistedLabelColumnPx = useViewStore((s) => s.roadmapLabelColumnPx);
  const persistLabelColumnPx = useViewStore((s) => s.setRoadmapLabelColumnPx);
  const [labelColumnPx, setLabelColumnPx] = useState(persistedLabelColumnPx);
  // If the persisted value changes out-of-band (persist rehydration
  // after mount, another tab writing via storage events, migration
  // clamp on load), pull it back in. Not fighting the user's live
  // drag: during a drag the store isn't touched, so this effect only
  // syncs when nothing local is in flight.
  useEffect(() => {
    setLabelColumnPx(persistedLabelColumnPx);
  }, [persistedLabelColumnPx]);

  const canWrite = useCanWrite();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("6mo");
  const [helperOpen, setHelperOpen] = useState(false);
  // Ref-bound to the roadmap "content" wrapper — everything except
  // the FilterBar. Passed to the PDF exporter so the download
  // includes the timeframe/legend header AND the Gantt/Unscheduled
  // content (but skips the filter UI, which isn't meaningful in a
  // static artefact).
  const exportRef = useRef<HTMLDivElement | null>(null);
  const [exporting, setExporting] = useState(false);
  // Toggled on immediately before the PDF snapshot and off after
  // it resolves. When true, GanttTimeline clamps its chart to
  // `today - 30 days` and paints a soft left-edge fade on bars
  // whose real span extends earlier. Interactive rendering is
  // unaffected because this flag is false the rest of the time.
  // The state has to live above <GanttTimeline /> (not inside the
  // exporter) so React's reconciliation actually re-renders the
  // chart with the PDF viewport before html-to-image serialises
  // the DOM — see `handleExportPdf` for the flushSync bookend.
  const [pdfMode, setPdfMode] = useState(false);

  // Roadmap-scoped visibility filter. Items in the Archive
  // (`is_archive` schema flag) or Parking Lot (case-insensitive
  // name match — the same soft convention BoardView and
  // EZEstimatesView use) are hidden from the Gantt, the
  // Unscheduled list, the Recent-changes feed, AND the
  // Auto-schedule picker. Applied ONCE here so every derived
  // list downstream reads from the same pre-filtered set.
  //
  // Kept above the loading early-return per the hook-order rule
  // enforced elsewhere in this component.
  const visibleProjects = useMemo(() => {
    const laneById = new Map((lanes.data ?? []).map((l) => [l.id, l] as const));
    return (projects.data ?? []).filter((p) => {
      if (!p.swim_lane_id) return true;
      const lane = laneById.get(p.swim_lane_id);
      if (!lane) return true;
      if (lane.is_archive) return false;
      if (lane.name.trim().toLowerCase() === "parking lot") return false;
      return true;
    });
  }, [projects.data, lanes.data]);
  const visibleProjectIds = useMemo(
    () => new Set(visibleProjects.map((p) => p.id)),
    [visibleProjects],
  );

  async function handleExportPdf() {
    if (!exportRef.current || exporting) return;
    setExporting(true);
    try {
      // Dynamic-import so jspdf + html-to-image (~350kB gzipped) only
      // enter the bundle when a user actually clicks Export. Roadmap
      // is the app's most-hit tab, so the initial-render cost matters
      // more than the ~200ms lazy fetch on first export.
      const { exportRoadmapToPdf } = await import("../lib/exportRoadmapPdf");
      // flushSync forces React to commit the pdfMode=true render
      // synchronously — without it, `setPdfMode(true)` would batch
      // and the exporter might snapshot the pre-PDF DOM. The `try`
      // guarantees pdfMode is turned back off even if the exporter
      // throws (e.g. cross-origin image, out-of-memory canvas), so
      // the interactive view can't get stuck in the trimmed-viewport
      // state after a failed export.
      flushSync(() => setPdfMode(true));
      try {
        await exportRoadmapToPdf({ root: exportRef.current });
      } finally {
        flushSync(() => setPdfMode(false));
      }
    } catch (err) {
      // Surface a plain alert; the export path has no in-flight
      // mutation state to hang a banner on. Logs the underlying
      // error for support / bug reports.
      console.error("PDF export failed", err);
      alert("PDF export failed. Check the browser console for details.");
    } finally {
      setExporting(false);
    }
  }

  if (projects.isLoading) return <div className="p-6 text-sm text-wp-slate">Loading roadmap…</div>;

  const filtered = applyFilters(visibleProjects, filters);
  const scheduled = filtered.filter((p) => computePhases(p).scheduled);
  const unscheduled = filtered.filter((p) => !computePhases(p).scheduled);

  // Viewport filter: hide scheduled rows whose entire span sits
  // outside the currently-visible timeframe. Keeps the Gantt from
  // wasting vertical space on rows the PM has to scroll past to
  // see. Only affects the Gantt — the Unscheduled list, Recent
  // Changes, and Auto-scheduler picker still see the full
  // `visibleProjects` / `scheduled` / `unscheduled` sets.
  //
  // Edge case: an epic that's itself out-of-range but has any
  // in-range subtask is kept so those subtask rows still have a
  // parent to render under. The `expandedEpicIds` state decides
  // whether the subtasks are actually visible; if all of an epic's
  // subtasks fall out of the viewport the epic simply loses its
  // chevron affordance (hasChildren derives from the passed list
  // inside GanttTimeline). See the file-header notes in
  // `lib/roadmapViewport.ts` for the precise date-range predicate.
  //
  // When zoom === "all" `isProjectInRoadmapViewport` short-circuits
  // to true, so this filter naturally becomes a no-op.
  const scheduledById = indexById(scheduled);
  const inRangeIds = new Set<string>();
  for (const p of scheduled) {
    if (isProjectInRoadmapViewport(p, zoom)) inRangeIds.add(p.id);
  }
  const finalIds = new Set(inRangeIds);
  for (const id of inRangeIds) {
    // Walk up parents that are also in the scheduled set. An
    // out-of-range epic whose in-range subtask lives underneath it
    // still needs to render so the row hierarchy is preserved.
    const seed = scheduledById.get(id);
    let parentId = seed?.parent_id ?? null;
    let hops = 0;
    while (parentId && hops < 32) {
      if (finalIds.has(parentId)) break;
      const parent = scheduledById.get(parentId);
      if (!parent) break;
      finalIds.add(parent.id);
      parentId = parent.parent_id ?? null;
      hops++;
    }
  }
  const scheduledInViewport = scheduled.filter((p) => finalIds.has(p.id));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar view="roadmap" showGrouping showColorBy />
      {/* Everything from here down is captured by the PDF exporter.
          Wrapped in a single ref-bound div so the exporter has one
          well-defined subtree to snapshot; the wrapper itself adds
          no styling to keep the DOM shape identical to before. */}
      <div ref={exportRef} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-2 border-b border-wp-stone bg-white/60 px-4 py-2">
          {/* Row 1: timeframe + action(s). Kept compact so the two
              legends below get their own breathing room. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-wp-slate">Timeframe</span>
              <div className="inline-flex overflow-hidden rounded-md border border-wp-stone">
                <button
                  className={`px-2 py-1 ${zoom === "3mo" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
                  onClick={() => setZoom("3mo")}
                >
                  3 months
                </button>
                <button
                  className={`border-l border-wp-stone px-2 py-1 ${zoom === "6mo" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
                  onClick={() => setZoom("6mo")}
                >
                  6 months
                </button>
                <button
                  className={`border-l border-wp-stone px-2 py-1 ${zoom === "1yr" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
                  onClick={() => setZoom("1yr")}
                >
                  1 year
                </button>
                <button
                  className={`border-l border-wp-stone px-2 py-1 ${zoom === "all" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
                  onClick={() => setZoom("all")}
                  title="Fit the entire scheduled roadmap on one screen"
                >
                  All
                </button>
              </div>
            </div>
            {/* Actions cluster — Export PDF is always available;
                Auto-schedule is admin/owner-only. `data-pdf-exclude`
                keeps this control cluster out of the snapshot so the
                exported PDF isn't dominated by app chrome. */}
            <div className="flex items-center gap-2" data-pdf-exclude="true">
              <button
                type="button"
                className="btn-secondary !py-1 !text-xs"
                onClick={handleExportPdf}
                disabled={exporting}
                title="Download the roadmap as a PDF file"
              >
                <FileDown size={12} />
                {exporting ? "Exporting…" : "Export PDF"}
              </button>
              {canWrite ? (
                <button
                  className="btn-secondary !py-1 !text-xs"
                  onClick={() => setHelperOpen(true)}
                  title="Propose an optimized schedule for a batch of items"
                >
                  <Wand2 size={12} />
                  Auto-schedule…
                </button>
              ) : null}
            </div>
          </div>
          {/* Row 2: color legend (dynamic — depends on the current
              colorBy dimension and which items are visible). */}
          <ColorLegend
            colorBy={colorBy}
            lanes={lanes.data ?? []}
            teams={teams.data ?? []}
            users={users.data ?? []}
            scopedProjects={scheduledInViewport}
          />
          {/* Row 3: phase legend (static reference for the bar
              styling; separated so the two legends don't compete
              for horizontal space). */}
          <PhaseLegend />
        </div>

        {/* Interactive rendering scrolls this pane; PDF mode drops
            the overflow clip so the exporter captures the full
            chart width + all recent/unscheduled rows without
            html-to-image's foreignObject clone silently cropping
            the SVG's tail to the visible viewport. */}
        <div className={pdfMode ? "flex-1" : "flex-1 overflow-auto"}>
          {scheduledInViewport.length ? (
            <GanttTimeline
              projects={scheduledInViewport}
              lanes={lanes.data ?? []}
              teams={teams.data ?? []}
              users={users.data ?? []}
              colorBy={colorBy}
              groupBy={groupBy}
              zoom={zoom}
              onOpen={setSelectedId}
              pdfMode={pdfMode}
              labelColumnPx={labelColumnPx}
              onLabelColumnPxChange={setLabelColumnPx}
              onLabelColumnPxCommit={persistLabelColumnPx}
            />
          ) : (
            // Two distinct empty states: nothing scheduled at all vs.
            // things scheduled but none in the current viewport. The
            // second case is common on tight zooms — telling the PM
            // "no items in this timeframe" (rather than "no items
            // period") avoids sending them to add dates that already
            // exist.
            <div className="p-6 text-sm text-wp-slate">
              {scheduled.length === 0
                ? "No scheduled projects match the current filters. Add start/target dates and duration estimates to plot a project."
                : "No scheduled projects fall inside this timeframe. Widen the zoom (or pick All) to see items outside the current window."}
            </div>
          )}

          {/* Recent-changes section sits between the Gantt and the
              Unscheduled list. Rendered unconditionally — the empty
              state is still informative ("No changes in the last 7
              days") and dropping the section entirely would leave
              users wondering whether the view is broken. */}
          <RecentChanges
            events={recentChanges.data?.events ?? []}
            days={recentChanges.data?.days ?? 7}
            truncated={recentChanges.data?.truncated ?? false}
            onOpenProject={setSelectedId}
            visibleProjectIds={visibleProjectIds}
          />

          {/* Rendered unconditionally so the collapsed header (with
              its count summary) always confirms the section exists,
              even when there are zero unscheduled items. Mirrors the
              treatment of the Recent-changes section above. */}
          <UnscheduledList
            projects={unscheduled}
            lanes={lanes.data ?? []}
            users={users.data ?? []}
            teams={teams.data ?? []}
            onOpen={setSelectedId}
          />
        </div>
      </div>

      {selectedId ? (
        <ProjectDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenProject={setSelectedId}
          // Roadmap reading order: scheduled bars first (in the same
          // filter order the chart consumes), then the unscheduled
          // list below. Matches the top-to-bottom flow of the page,
          // even though GanttTimeline visually regroups by
          // team/lane/etc. — good enough for prev/next semantics
          // without piping the grouped indices out of the chart.
          siblingIds={[...scheduled, ...unscheduled].map((p) => p.id)}
        />
      ) : null}

      {helperOpen ? (
        <RoadmapHelper
          projects={visibleProjects}
          lanes={lanes.data ?? []}
          users={users.data ?? []}
          teams={teams.data ?? []}
          // Seed the modal's team/owner chip filters from the
          // Roadmap's live filter state so the pick list matches
          // what the user was just looking at. Only team + owner
          // are forwarded because those are the only two filter
          // controls the modal exposes; the modal's `useState`
          // lazy initializer consumes these once on open, so the
          // user can still change them inside the modal without
          // being fought by a re-sync. The modal closes without
          // touching this state, so nothing propagates back.
          initialTeamIds={filters.teamIds}
          initialOwnerIds={filters.ownerIds}
          onClose={() => setHelperOpen(false)}
        />
      ) : null}
    </div>
  );
}
