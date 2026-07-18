import { useRef, useState } from "react";
import { FileDown, Wand2 } from "lucide-react";
import { useCanWrite, useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { applyFilters } from "../lib/filtering";
import { useViewStore } from "../lib/viewState";
import { computePhases } from "../lib/phaseCompute";
import { FilterBar } from "../components/FilterBar";
import { GanttTimeline } from "../components/GanttTimeline";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { UnscheduledList } from "../components/UnscheduledList";
import { PhaseLegend } from "../components/PhaseLegend";
import { ColorLegend } from "../components/ColorLegend";
import { RoadmapHelper } from "../components/RoadmapHelper";

export function RoadmapView() {
  const projects = useProjects();
  const lanes = useSwimLanes();
  const teams = useTeams();
  const users = useUsers();
  const filters = useViewStore((s) => s.roadmap.filters);
  const colorBy = useViewStore((s) => s.roadmap.colorBy);
  const groupBy = useViewStore((s) => s.roadmap.groupBy);

  const canWrite = useCanWrite();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<"3mo" | "6mo" | "1yr">("6mo");
  const [helperOpen, setHelperOpen] = useState(false);
  // Ref-bound to the roadmap "content" wrapper — everything except
  // the FilterBar. Passed to the PDF exporter so the download
  // includes the timeframe/legend header AND the Gantt/Unscheduled
  // content (but skips the filter UI, which isn't meaningful in a
  // static artefact).
  const exportRef = useRef<HTMLDivElement | null>(null);
  const [exporting, setExporting] = useState(false);

  async function handleExportPdf() {
    if (!exportRef.current || exporting) return;
    setExporting(true);
    try {
      // Dynamic-import so jspdf + html-to-image (~350kB gzipped) only
      // enter the bundle when a user actually clicks Export. Roadmap
      // is the app's most-hit tab, so the initial-render cost matters
      // more than the ~200ms lazy fetch on first export.
      const { exportRoadmapToPdf } = await import("../lib/exportRoadmapPdf");
      await exportRoadmapToPdf({ root: exportRef.current });
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

  const filtered = projects.data ? applyFilters(projects.data, filters) : [];
  const scheduled = filtered.filter((p) => computePhases(p).scheduled);
  const unscheduled = filtered.filter((p) => !computePhases(p).scheduled);

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
            scopedProjects={scheduled}
          />
          {/* Row 3: phase legend (static reference for the bar
              styling; separated so the two legends don't compete
              for horizontal space). */}
          <PhaseLegend />
        </div>

        <div className="flex-1 overflow-auto">
          {scheduled.length ? (
            <GanttTimeline
              projects={scheduled}
              lanes={lanes.data ?? []}
              teams={teams.data ?? []}
              users={users.data ?? []}
              colorBy={colorBy}
              groupBy={groupBy}
              zoom={zoom}
              onOpen={setSelectedId}
            />
          ) : (
            <div className="p-6 text-sm text-wp-slate">
              No scheduled projects match the current filters. Add start/target dates and duration estimates to plot a project.
            </div>
          )}

          {unscheduled.length ? (
            <UnscheduledList
              projects={unscheduled}
              lanes={lanes.data ?? []}
              users={users.data ?? []}
              teams={teams.data ?? []}
              onOpen={setSelectedId}
            />
          ) : null}
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
          projects={projects.data ?? []}
          lanes={lanes.data ?? []}
          users={users.data ?? []}
          teams={teams.data ?? []}
          onClose={() => setHelperOpen(false)}
        />
      ) : null}
    </div>
  );
}
