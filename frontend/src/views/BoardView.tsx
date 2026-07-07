import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors, closestCenter,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import { useMe, useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import type { Project, SwimLane, Team, User } from "../lib/types";
import { useViewStore } from "../lib/viewState";
import { applyFilters } from "../lib/filtering";
import { FilterBar } from "../components/FilterBar";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import { NewProjectDialog } from "../components/NewProjectDialog";
import { InfoTooltip } from "../components/InfoTooltip";

export function BoardView() {
  const me = useMe();
  const lanes = useSwimLanes();
  const projects = useProjects();
  const users = useUsers();
  const teams = useTeams();
  const filters = useViewStore((s) => s.board.filters);
  const colorBy = useViewStore((s) => s.board.colorBy);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newInLane, setNewInLane] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const p = searchParams.get("project");
    if (p) {
      setSelectedId(p);
      const next = new URLSearchParams(searchParams);
      next.delete("project");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const qc = useQueryClient();
  const canWrite = me.data?.role !== "viewer";

  const filtered = useMemo(() => (projects.data ? applyFilters(projects.data, filters) : []), [projects.data, filters]);

  const grouped = useMemo(() => {
    const byLane = new Map<string | null, Project[]>();
    for (const p of filtered) {
      const key = p.swim_lane_id ?? null;
      const arr = byLane.get(key) ?? [];
      arr.push(p);
      byLane.set(key, arr);
    }
    for (const arr of byLane.values()) arr.sort((a, b) => a.position - b.position);
    return byLane;
  }, [filtered]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const moveMutation = useMutation({
    mutationFn: async (v: { id: string; swim_lane_id: string | null; position: number }) => {
      return api(`/projects/${v.id}/move`, {
        method: "POST",
        body: JSON.stringify({ swim_lane_id: v.swim_lane_id, position: v.position }),
      });
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["projects"] });
      const prev = qc.getQueryData<Project[]>(["projects"]);
      if (prev) {
        qc.setQueryData<Project[]>(["projects"], prev.map((p) =>
          p.id === v.id ? { ...p, swim_lane_id: v.swim_lane_id, position: v.position } : p,
        ));
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["projects"], ctx.prev);
      const msg = err instanceof Error ? err.message : "Move failed. Try again.";
      alert(msg);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
    },
  });

  const activeProject = activeId ? filtered.find((p) => p.id === activeId) : null;

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || !canWrite) return;
    const activeProject = filtered.find((p) => p.id === active.id);
    if (!activeProject) return;

    // over.id may be a project id (dropped on a card) or a lane id (dropped on empty lane).
    const overIdStr = String(over.id);
    let targetLaneId: string | null;
    let targetPosition: number;

    if (overIdStr.startsWith("lane:")) {
      targetLaneId = overIdStr.slice("lane:".length) || null;
      if (targetLaneId === "null") targetLaneId = null;
      const laneItems = (grouped.get(targetLaneId) ?? []).filter((p) => p.id !== activeProject.id);
      targetPosition = laneItems.length;
    } else {
      const overProject = filtered.find((p) => p.id === overIdStr);
      if (!overProject) return;
      targetLaneId = overProject.swim_lane_id;
      const laneItems = (grouped.get(targetLaneId) ?? []).filter((p) => p.id !== activeProject.id);
      const overIndex = laneItems.findIndex((p) => p.id === overProject.id);
      targetPosition = overIndex >= 0 ? overIndex : laneItems.length;
    }
    if (targetLaneId === activeProject.swim_lane_id && targetPosition === activeProject.position) return;
    moveMutation.mutate({ id: activeProject.id, swim_lane_id: targetLaneId, position: targetPosition });
  }

  if (lanes.isLoading || projects.isLoading) {
    return <div className="p-6 text-sm text-wp-slate">Loading board…</div>;
  }

  const laneList = lanes.data ?? [];
  const unassignedProjects = grouped.get(null) ?? [];

  if (laneList.length === 0) {
    return (
      <div className="p-8">
        <div className="card-surface mx-auto max-w-lg p-6 text-center">
          <h2 className="text-base font-semibold text-wp-ink">No swim lanes yet</h2>
          <p className="mt-1 text-sm text-wp-slate">
            An admin needs to create a swim lane before cards can be organized on the board.
          </p>
          {me.data?.role === "admin" ? (
            <a href="/admin" className="btn-primary mt-4 inline-flex">Go to Admin Settings</a>
          ) : null}
          {unassignedProjects.length > 0 ? (
            <p className="mt-3 text-xs text-wp-slate">
              {unassignedProjects.length} card(s) currently unassigned.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar view="board" />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full min-w-max items-start gap-3 p-4">
            {unassignedProjects.length > 0 ? (
              <LaneColumn
                lane={null}
                projects={unassignedProjects}
                onNewInLane={() => setNewInLane("")}
                onOpen={setSelectedId}
                colorBy={colorBy}
                users={users.data ?? []}
                teams={teams.data ?? []}
                lanes={laneList}
                canWrite={canWrite}
              />
            ) : null}
            {laneList.map((lane) => (
              <LaneColumn
                key={lane.id}
                lane={lane}
                projects={grouped.get(lane.id) ?? []}
                onNewInLane={() => setNewInLane(lane.id)}
                onOpen={setSelectedId}
                colorBy={colorBy}
                users={users.data ?? []}
                teams={teams.data ?? []}
                lanes={laneList}
                canWrite={canWrite}
              />
            ))}
          </div>
        </div>
        <DragOverlay>
          {activeProject ? (
            <ProjectCard
              project={activeProject}
              colorBy={colorBy}
              users={users.data ?? []}
              teams={teams.data ?? []}
              lanes={laneList}
              isDragging
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {selectedId ? (
        <ProjectDetailPanel id={selectedId} onClose={() => setSelectedId(null)} />
      ) : null}
      {newInLane !== null ? (
        <NewProjectDialog defaultLaneId={newInLane || null} onClose={() => setNewInLane(null)} />
      ) : null}
    </div>
  );
}

function LaneColumn(props: {
  lane: SwimLane | null;
  projects: Project[];
  onNewInLane: () => void;
  onOpen: (id: string) => void;
  colorBy: import("../lib/viewState").ColorBy;
  users: User[];
  teams: Team[];
  lanes: SwimLane[];
  canWrite: boolean;
}) {
  const { lane, projects, onNewInLane, onOpen, colorBy, users, teams, lanes, canWrite } = props;
  const laneId = lane?.id ?? "null";
  const droppableId = `lane:${laneId}`;

  return (
    <div className="flex h-full w-72 shrink-0 flex-col rounded-lg bg-wp-stone/40">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: lane?.color ?? "#94a3b8" }}
            aria-hidden
          />
          <InfoTooltip content={lane?.description}>
            <span
              className={`text-sm font-semibold text-wp-ink ${lane?.description ? "cursor-help underline decoration-dotted decoration-wp-slate/40 underline-offset-4" : ""}`}
            >
              {lane?.name ?? "Unassigned"}
            </span>
          </InfoTooltip>
          <span className="text-xs text-wp-slate">{projects.length}</span>
          {lane?.requires_weekly_status ? (
            <span className="chip !border-amber-300 !bg-amber-50 !text-amber-800">status</span>
          ) : null}
          {lane?.is_terminal ? (
            <span className="chip !border-emerald-300 !bg-emerald-50 !text-emerald-800">terminal</span>
          ) : null}
        </div>
        {canWrite && lane ? (
          <button className="btn-ghost !p-1" aria-label="Add card" onClick={onNewInLane}>
            <Plus size={16} />
          </button>
        ) : null}
      </div>

      <SortableContext
        items={projects.map((p) => p.id)}
        strategy={verticalListSortingStrategy}
        id={droppableId}
      >
        <LaneDroppable id={droppableId}>
          <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-3">
            {projects.map((p) => (
              <SortableCard
                key={p.id}
                project={p}
                onOpen={() => onOpen(p.id)}
                colorBy={colorBy}
                users={users}
                teams={teams}
                lanes={lanes}
              />
            ))}
            {projects.length === 0 ? (
              <div className="rounded border border-dashed border-wp-stone px-2 py-6 text-center text-xs text-wp-slate">
                Drop cards here
              </div>
            ) : null}
          </div>
        </LaneDroppable>
      </SortableContext>
    </div>
  );
}

function LaneDroppable({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-1 flex-col rounded-md transition ${isOver ? "bg-wp-red/5" : ""}`}
    >
      {children}
    </div>
  );
}

function SortableCard(props: {
  project: Project;
  onOpen: () => void;
  colorBy: import("../lib/viewState").ColorBy;
  users: User[];
  teams: Team[];
  lanes: SwimLane[];
}) {
  const { project, onOpen, colorBy, users, teams, lanes } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return (
    <div ref={setNodeRef} style={style}>
      <ProjectCard
        project={project}
        colorBy={colorBy}
        users={users}
        teams={teams}
        lanes={lanes}
        onOpen={onOpen}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
