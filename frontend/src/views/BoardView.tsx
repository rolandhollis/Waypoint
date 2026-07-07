import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors, closestCenter,
  type DragCancelEvent, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
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
import { PhaseDatePromptModal } from "../components/PhaseDatePromptModal";
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
  // `null` = dialog closed. When open, the value is the lane id the new
  // card should land in (empty string means "Unassigned").
  const [newInLane, setNewInLane] = useState<string | null>(null);
  // When a cross-lane move lands in a phase-bound lane (see
  // swim_lanes.phase_date_key), we defer showing the prompt until the
  // server confirms the move so the modal isn't rendered on top of a
  // failed drop. Carries just enough to identify project + lane.
  const [phasePrompt, setPhasePrompt] = useState<{ projectId: string; laneId: string } | null>(null);
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
    mutationFn: async (v: {
      id: string;
      swim_lane_id: string | null;
      position: number;
      /** Snapshot taken by handleDragEnd for rollback on server error. */
      _prev: Project[] | undefined;
      /** Set on a cross-lane move so onSuccess can decide whether to
       *  open the phase-date prompt. Same-lane reorders leave this false. */
      _crossLane: boolean;
    }) => {
      return api(`/projects/${v.id}/move`, {
        method: "POST",
        body: JSON.stringify({ swim_lane_id: v.swim_lane_id, position: v.position }),
      });
    },
    // Note: no onMutate — the optimistic reorder happens synchronously in
    // handleDragEnd, in the same React batch as setActiveId(null), so the
    // sortable context never sees an in-between frame where the drag has
    // ended but the new order hasn't arrived yet. onMutate is async by
    // nature (React Query awaits its return before calling mutationFn),
    // which is exactly the gap that caused the "cards fly back to origin
    // then jump" animation glitch.
    onSuccess: (_data, v) => {
      if (!v._crossLane || !v.swim_lane_id) return;
      const destLane = lanes.data?.find((l) => l.id === v.swim_lane_id);
      if (destLane?.phase_date_key) {
        setPhasePrompt({ projectId: v.id, laneId: v.swim_lane_id });
      }
    },
    onError: (err, v) => {
      if (v._prev) qc.setQueryData(["projects"], v._prev);
      const msg = err instanceof Error ? err.message : "Move failed. Try again.";
      alert(msg);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
    },
  });

  const activeProject = activeId ? filtered.find((p) => p.id === activeId) : null;

  // Snapshot of the cache captured at drag-start. Used to:
  //   (a) roll back if the drag is cancelled or the server rejects, and
  //   (b) compute the *original* position for the no-op check on drop
  //       (since dragOver may have already moved the card cross-lane).
  // A ref so mutating it doesn't trigger renders during the drag.
  const dragSnapshotRef = useRef<Project[] | null>(null);

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    dragSnapshotRef.current = qc.getQueryData<Project[]>(["projects"]) ?? null;
  }

  // Cross-lane preview: as soon as the pointer enters a different lane,
  // splice the active card into that lane's cache list so the
  // destination's SortableContext can animate its cards out of the way.
  // Same-lane rearranging is handled by SortableContext transforms and
  // needs no cache write.
  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || !canWrite) return;
    const cache = qc.getQueryData<Project[]>(["projects"]);
    if (!cache) return;
    const activeProject = cache.find((p) => p.id === active.id);
    if (!activeProject) return;

    const overIdStr = String(over.id);
    let overLaneId: string | null;
    let overPosition: number;

    if (overIdStr.startsWith("lane:")) {
      overLaneId = overIdStr.slice("lane:".length) || null;
      if (overLaneId === "null") overLaneId = null;
      const laneItems = cache.filter((p) => p.swim_lane_id === overLaneId && p.id !== activeProject.id);
      overPosition = laneItems.length;
    } else {
      const overProject = cache.find((p) => p.id === overIdStr);
      if (!overProject || overProject.id === activeProject.id) return;
      overLaneId = overProject.swim_lane_id;

      // Direction-aware insertion. Split the over card into an upper
      // half ("insert before") and lower half ("insert after") so
      // slotting between two closely-stacked cards is not razor-thin.
      // Compare the drag preview's translated midpoint to the over
      // card's midpoint; hover higher on the card = above, lower on
      // the card = below.
      const activeRect = active.rect.current.translated;
      const overRect = over.rect;
      const activeMidY = activeRect ? activeRect.top + activeRect.height / 2 : null;
      const overMidY = overRect ? overRect.top + overRect.height / 2 : null;
      const insertAfter =
        activeMidY != null && overMidY != null && activeMidY > overMidY;
      overPosition = overProject.position + (insertAfter ? 1 : 0);
    }

    // Only intervene on cross-lane transitions. Once the active card
    // has already been placed into the destination lane, subsequent
    // dragOver events within the same lane fall through to
    // SortableContext for smooth in-lane transforms.
    if (overLaneId === activeProject.swim_lane_id) return;

    qc.setQueryData<Project[]>(
      ["projects"],
      reindexAfterMove(cache, activeProject.id, overLaneId, overPosition),
    );
  }

  function handleDragCancel(_e: DragCancelEvent) {
    if (dragSnapshotRef.current) {
      qc.setQueryData<Project[]>(["projects"], dragSnapshotRef.current);
    }
    dragSnapshotRef.current = null;
    setActiveId(null);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    const snapshot = dragSnapshotRef.current;
    dragSnapshotRef.current = null;

    // Read the *current* cache — after any dragOver previews. The active
    // card may already have hopped to a different lane in this snapshot.
    const cache = qc.getQueryData<Project[]>(["projects"]);
    const activeProject = cache?.find((p) => p.id === active.id);

    function bail() {
      if (snapshot) qc.setQueryData<Project[]>(["projects"], snapshot);
      setActiveId(null);
    }

    if (!over || !canWrite || !activeProject || !cache) {
      bail();
      return;
    }

    const overIdStr = String(over.id);
    let targetLaneId: string | null = activeProject.swim_lane_id;
    let targetPosition: number = activeProject.position;

    if (overIdStr.startsWith("lane:")) {
      // Dropped on the lane background. If we've already moved the card
      // here via dragOver, keep its computed position; otherwise put it
      // at the end of the lane.
      targetLaneId = overIdStr.slice("lane:".length) || null;
      if (targetLaneId === "null") targetLaneId = null;
      if (targetLaneId !== activeProject.swim_lane_id) {
        const laneItems = cache.filter((p) => p.swim_lane_id === targetLaneId && p.id !== activeProject.id);
        targetPosition = laneItems.length;
      }
    } else {
      const overProject = cache.find((p) => p.id === overIdStr);
      if (!overProject) { bail(); return; }
      targetLaneId = overProject.swim_lane_id;

      // dragOver ensures activeProject is in overProject's lane by now,
      // so arrayMove semantics inside that lane handle both same-lane
      // and cross-lane cases identically.
      const laneItems = cache
        .filter((p) => p.swim_lane_id === targetLaneId)
        .sort((a, b) => a.position - b.position);
      const oldIndex = laneItems.findIndex((p) => p.id === activeProject.id);
      const newIndex = laneItems.findIndex((p) => p.id === overProject.id);
      if (oldIndex < 0 || newIndex < 0) { bail(); return; }
      if (oldIndex !== newIndex) {
        const reordered = arrayMove(laneItems, oldIndex, newIndex);
        targetPosition = reordered.findIndex((p) => p.id === activeProject.id);
      }
    }

    // No-op check against the *original* (pre-drag) location, not the
    // dragOver-shuffled cache. Otherwise a drag out + back to origin
    // would look like a change and re-hit the server.
    const originalActive = snapshot?.find((p) => p.id === activeProject.id);
    if (
      originalActive &&
      originalActive.swim_lane_id === targetLaneId &&
      originalActive.position === targetPosition
    ) {
      bail();
      return;
    }

    // Commit the final layout synchronously (in the same React batch as
    // setActiveId(null)) so the SortableContext doesn't briefly animate
    // cards back to their pre-drop positions before the cache update
    // catches up. Base the final reindex on the pre-drag snapshot so
    // any intermediate dragOver writes are cleanly superseded.
    const base = snapshot ?? cache;
    qc.cancelQueries({ queryKey: ["projects"] });
    qc.setQueryData<Project[]>(
      ["projects"],
      reindexAfterMove(base, activeProject.id, targetLaneId, targetPosition),
    );
    setActiveId(null);

    const wasCrossLane = originalActive
      ? originalActive.swim_lane_id !== targetLaneId
      : false;

    moveMutation.mutate({
      id: activeProject.id,
      swim_lane_id: targetLaneId,
      position: targetPosition,
      _prev: snapshot ?? undefined,
      _crossLane: wasCrossLane,
    });
  }

  if (lanes.isLoading || projects.isLoading) {
    return <div className="p-6 text-sm text-wp-slate">Loading board…</div>;
  }

  const laneList = lanes.data ?? [];
  // Admin-picked landing lane for the single "Add new item" CTA; the
  // backend resolves the same lane server-side so passing null still
  // works if this is ever out of sync.
  const defaultNewLane =
    laneList.find((l) => l.is_default_new) ??
    laneList.filter((l) => !l.is_terminal).sort((a, b) => a.order - b.order)[0] ??
    laneList[0] ??
    null;

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
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar view="board" showSwimLaneFilter={false} />
      {canWrite ? (
        <div className="flex items-center justify-between border-b border-wp-stone bg-white/60 px-4 py-2">
          <p className="text-xs text-wp-slate">
            New items land in <span className="font-medium text-wp-ink">{defaultNewLane?.name}</span>.
          </p>
          <button
            className="btn-primary inline-flex items-center gap-1.5"
            onClick={() => setNewInLane(defaultNewLane?.id ?? "")}
          >
            <Plus size={14} /> Add new item
          </button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex h-full min-w-max items-start gap-3 p-4">
            {laneList.map((lane) => (
              <LaneColumn
                key={lane.id}
                lane={lane}
                projects={grouped.get(lane.id) ?? []}
                onOpen={setSelectedId}
                colorBy={colorBy}
                users={users.data ?? []}
                teams={teams.data ?? []}
                lanes={laneList}
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
      {phasePrompt ? (() => {
        // Both must still exist by the time the mutation resolves —
        // deleting the card or the lane between drop and prompt is
        // rare but possible. Bail silently rather than crashing.
        const promptProject = projects.data?.find((p) => p.id === phasePrompt.projectId);
        const promptLane = lanes.data?.find((l) => l.id === phasePrompt.laneId);
        if (!promptProject || !promptLane) return null;
        return (
          <PhaseDatePromptModal
            project={promptProject}
            lane={promptLane}
            onDismiss={() => setPhasePrompt(null)}
          />
        );
      })() : null}
    </div>
  );
}

function LaneColumn(props: {
  lane: SwimLane;
  projects: Project[];
  onOpen: (id: string) => void;
  colorBy: import("../lib/viewState").ColorBy;
  users: User[];
  teams: Team[];
  lanes: SwimLane[];
}) {
  const { lane, projects, onOpen, colorBy, users, teams, lanes } = props;
  const droppableId = `lane:${lane.id}`;

  return (
    <div className="flex h-full w-72 shrink-0 flex-col rounded-lg bg-wp-stone/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ background: lane.color ?? "#94a3b8" }}
          aria-hidden
        />
        <InfoTooltip content={lane.description}>
          <span
            className={`text-sm font-semibold text-wp-ink ${lane.description ? "cursor-help underline decoration-dotted decoration-wp-slate/40 underline-offset-4" : ""}`}
          >
            {lane.name}
          </span>
        </InfoTooltip>
        <span className="text-xs text-wp-slate">{projects.length}</span>
        {lane.is_default_new ? (
          <span className="chip !border-wp-red/40 !bg-wp-red/10 !text-wp-red" title="New items land here by default.">default</span>
        ) : null}
        {lane.requires_weekly_status ? (
          <span className="chip !border-amber-300 !bg-amber-50 !text-amber-800">status</span>
        ) : null}
        {lane.is_terminal ? (
          <span className="chip !border-emerald-300 !bg-emerald-50 !text-emerald-800">terminal</span>
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

/**
 * Given the current projects snapshot, produce the version that would
 * exist after moving `activeId` into `targetLaneId` at `targetPosition`.
 * Renumbers positions in both the destination lane (splicing in the
 * moved card) and, on cross-lane moves, the source lane (closing the
 * gap) so the resulting snapshot has no ties or holes and matches the
 * shape the server will return.
 */
function reindexAfterMove(
  prev: Project[],
  activeId: string,
  targetLaneId: string | null,
  targetPosition: number,
): Project[] {
  const active = prev.find((p) => p.id === activeId);
  if (!active) return prev;

  const destItems = prev
    .filter((p) => p.swim_lane_id === targetLaneId && p.id !== activeId)
    .sort((a, b) => a.position - b.position);
  const clampedPos = Math.max(0, Math.min(targetPosition, destItems.length));
  destItems.splice(clampedPos, 0, { ...active, swim_lane_id: targetLaneId });
  const destPosById = new Map<string, number>();
  destItems.forEach((p, i) => destPosById.set(p.id, i));

  let srcPosById: Map<string, number> | null = null;
  if (active.swim_lane_id !== targetLaneId) {
    const srcItems = prev
      .filter((p) => p.swim_lane_id === active.swim_lane_id && p.id !== activeId)
      .sort((a, b) => a.position - b.position);
    srcPosById = new Map();
    srcItems.forEach((p, i) => srcPosById!.set(p.id, i));
  }

  return prev.map((p) => {
    if (p.id === activeId) {
      return { ...p, swim_lane_id: targetLaneId, position: destPosById.get(p.id) ?? clampedPos };
    }
    if (destPosById.has(p.id)) return { ...p, position: destPosById.get(p.id)! };
    if (srcPosById?.has(p.id)) return { ...p, position: srcPosById.get(p.id)! };
    return p;
  });
}
