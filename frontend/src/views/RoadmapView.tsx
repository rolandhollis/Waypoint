import { useState } from "react";
import { useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { applyFilters } from "../lib/filtering";
import { useViewStore } from "../lib/viewState";
import { computePhases } from "../lib/phaseCompute";
import { FilterBar } from "../components/FilterBar";
import { GanttTimeline } from "../components/GanttTimeline";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { UnscheduledList } from "../components/UnscheduledList";
import { PhaseLegend } from "../components/PhaseLegend";
import { ColorLegend } from "../components/ColorLegend";

export function RoadmapView() {
  const projects = useProjects();
  const lanes = useSwimLanes();
  const teams = useTeams();
  const users = useUsers();
  const filters = useViewStore((s) => s.roadmap.filters);
  const colorBy = useViewStore((s) => s.roadmap.colorBy);
  const groupBy = useViewStore((s) => s.roadmap.groupBy);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<"6mo" | "1yr">("6mo");

  if (projects.isLoading) return <div className="p-6 text-sm text-wp-slate">Loading roadmap…</div>;

  const filtered = projects.data ? applyFilters(projects.data, filters) : [];
  const scheduled = filtered.filter((p) => computePhases(p).scheduled);
  const unscheduled = filtered.filter((p) => !computePhases(p).scheduled);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar view="roadmap" showGrouping showColorBy />
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-wp-stone bg-white/60 px-4 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-wp-slate">Timeframe</span>
          <div className="inline-flex overflow-hidden rounded-md border border-wp-stone">
            <button
              className={`px-2 py-1 ${zoom === "6mo" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
              onClick={() => setZoom("6mo")}
            >
              6 months
            </button>
            <button
              className={`px-2 py-1 ${zoom === "1yr" ? "bg-wp-red text-white" : "bg-white text-wp-slate"}`}
              onClick={() => setZoom("1yr")}
            >
              1 year
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <PhaseLegend />
          <ColorLegend
            colorBy={colorBy}
            lanes={lanes.data ?? []}
            teams={teams.data ?? []}
            users={users.data ?? []}
            scopedProjects={scheduled}
          />
        </div>
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

      {selectedId ? <ProjectDetailPanel id={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
