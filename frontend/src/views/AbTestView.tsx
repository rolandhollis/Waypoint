import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Calendar, GripVertical, Octagon, Pencil, Plus, Trash2, X } from "lucide-react";
import { format } from "date-fns";
import { AbTestDetailPanel, type AbTestItemPatch } from "../components/AbTestDetailPanel";
import { KanbanItemCreateModal } from "../components/KanbanItemCreateModal";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { UserAvatar } from "../components/UserAvatar";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { useAppDialog } from "../components/AppDialogProvider";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  useAbTestBoardLanes,
  useAbTestItems,
  useCanWrite,
  useIsAdmin,
  useMentionableUsers,
  useTeams,
} from "../lib/queries";
import type { AbTestBoardLane, AbTestItem } from "../lib/types";

type BoardLayoutBody = {
  columns: Array<{ lane_id: string; item_ids: string[] }>;
};

function laneSortableId(laneId: string) {
  return `lane:${laneId}`;
}

function parseLaneSortableId(id: string): string | null {
  return id.startsWith("lane:") ? id.slice("lane:".length) : null;
}

const boardCollision: CollisionDetection = (args) => {
  if (args.active.data.current?.type === "lane") {
    const laneContainers = args.droppableContainers.filter((c) =>
      String(c.id).startsWith("lane:"),
    );
    return closestCenter({ ...args, droppableContainers: laneContainers });
  }
  // Prefer ticket / column droppables over the outer lane sortable
  // wrapper so cross-column drops land on the target stage.
  const ticketContainers = args.droppableContainers.filter((c) => {
    const id = String(c.id);
    return !id.startsWith("lane:");
  });
  return closestCorners({ ...args, droppableContainers: ticketContainers });
};

function partitionBoard(items: AbTestItem[], lanes: AbTestBoardLane[]) {
  const active = items.filter((i) => !i.deleted_at);
  const byLane = new Map<string, AbTestItem[]>();
  for (const lane of lanes) byLane.set(lane.id, []);
  for (const item of active) {
    const list = byLane.get(item.lane_id);
    if (list) list.push(item);
    else if (lanes[0]) {
      const fallback = byLane.get(lanes[0].id);
      fallback?.push(item);
    }
  }
  for (const list of byLane.values()) {
    list.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  }
  return { byLane, activeCount: active.length };
}

function buildLayoutPayload(
  lanes: AbTestBoardLane[],
  byLane: Map<string, AbTestItem[]>,
): BoardLayoutBody {
  return {
    columns: lanes.map((lane) => ({
      lane_id: lane.id,
      item_ids: (byLane.get(lane.id) ?? []).map((i) => i.id),
    })),
  };
}

function resolveLaneIdFromOver(
  overId: string,
  overData: { laneId?: string } | null | undefined,
  lanes: AbTestBoardLane[],
  items: AbTestItem[],
): string | null {
  if (overData?.laneId) return overData.laneId;
  const fromPrefix = parseLaneSortableId(overId);
  if (fromPrefix) return fromPrefix;
  if (overId.startsWith("col:")) return overId.slice("col:".length);
  const ticket = items.find((i) => i.id === overId);
  if (ticket) return ticket.lane_id;
  return lanes.find((l) => l.id === overId)?.id ?? null;
}

export function AbTestView() {
  const items = useAbTestItems();
  const lanesQuery = useAbTestBoardLanes();
  const teams = useTeams();
  const users = useMentionableUsers();
  const canWrite = useCanWrite();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const { confirm, prompt } = useAppDialog();

  const lanes = lanesQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showAddLane, setShowAddLane] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamId, setTeamId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [laneId, setLaneId] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDragType, setActiveDragType] = useState<"ticket" | "lane" | null>(null);
  const dragSnapshotRef = useRef<AbTestItem[] | null>(null);
  const laneSnapshotRef = useRef<AbTestBoardLane[] | null>(null);
  const activeDragTypeRef = useRef<"ticket" | "lane" | null>(null);

  const board = useMemo(
    () => partitionBoard(items.data ?? [], lanes),
    [items.data, lanes],
  );

  const selectedItem = useMemo(
    () => (items.data ?? []).find((i) => i.id === selectedId && !i.deleted_at) ?? null,
    [items.data, selectedId],
  );

  const siblingIds = useMemo(() => {
    if (!selectedItem) return [];
    return (board.byLane.get(selectedItem.lane_id) ?? []).map((i) => i.id);
  }, [board.byLane, selectedItem]);

  const teamOptions = useMemo(
    () => (teams.data ?? []).map((t) => ({ id: t.id, name: t.name })),
    [teams.data],
  );
  const userOptions = users.data ?? [];
  const defaultLaneId = lanes[0]?.id ?? "";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const createMutation = useMutation({
    mutationFn: () =>
      api<AbTestItem>("/ab-test-items", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          team_id: teamId || null,
          assigned_to: assignedTo || null,
          lane_id: laneId || defaultLaneId || undefined,
        }),
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["abTestItems"] });
      setShowCreate(false);
      setName("");
      setDescription("");
      setTeamId("");
      setAssignedTo("");
      setLaneId("");
      setSelectedId(created.id);
    },
  });

  const patchMutation = useMutation({
    mutationFn: (v: { id: string; body: AbTestItemPatch }) =>
      api<AbTestItem>(`/ab-test-items/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify(v.body),
      }),
    onSuccess: (updated) => {
      qc.setQueryData<AbTestItem[]>(["abTestItems"], (prev) =>
        (prev ?? []).map((i) => (i.id === updated.id ? updated : i)),
      );
      qc.invalidateQueries({ queryKey: ["abTestItems"] });
      qc.invalidateQueries({ queryKey: ["abTestItemHistory"] });
    },
  });

  const layoutMutation = useMutation({
    mutationFn: (body: BoardLayoutBody) =>
      api<AbTestItem[]>("/ab-test-items/board-layout", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (list) => qc.setQueryData(["abTestItems"], list),
    onError: () => {
      if (dragSnapshotRef.current) {
        qc.setQueryData(["abTestItems"], dragSnapshotRef.current);
      }
    },
    onSettled: () => {
      dragSnapshotRef.current = null;
      qc.invalidateQueries({ queryKey: ["abTestItems"] });
      qc.invalidateQueries({ queryKey: ["abTestItemHistory"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/ab-test-items/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["abTestItems"] });
      qc.invalidateQueries({ queryKey: ["abTestItemHistory"] });
    },
  });

  const createLaneMutation = useMutation({
    mutationFn: (body: { name: string; is_terminal: boolean }) =>
      api<AbTestBoardLane>("/ab-test-board-lanes", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setShowAddLane(false);
      qc.invalidateQueries({ queryKey: ["abTestBoardLanes"] });
    },
  });

  const patchLaneMutation = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      api<AbTestBoardLane>(`/ab-test-board-lanes/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: v.name }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["abTestBoardLanes"] }),
  });

  const reorderLanesMutation = useMutation({
    mutationFn: (order: string[]) =>
      api<AbTestBoardLane[]>("/ab-test-board-lanes/reorder", {
        method: "POST",
        body: JSON.stringify({ order }),
      }),
    onSuccess: (list) => qc.setQueryData(["abTestBoardLanes"], list),
    onError: () => {
      if (laneSnapshotRef.current) {
        qc.setQueryData(["abTestBoardLanes"], laneSnapshotRef.current);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["abTestBoardLanes"] }),
  });

  const deleteLaneMutation = useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: string; tickets_moved: number }>(`/ab-test-board-lanes/${id}`, {
        method: "DELETE",
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["abTestBoardLanes"] });
      qc.invalidateQueries({ queryKey: ["abTestItems"] });
    },
  });

  function applyOptimisticLayout(nextByLane: Map<string, AbTestItem[]>) {
    const cache = qc.getQueryData<AbTestItem[]>(["abTestItems"]);
    if (!cache) return;
    dragSnapshotRef.current = cache;
    const laneMeta = new Map(lanes.map((l) => [l.id, l]));
    const renumbered = cache.map((item) => {
      if (item.deleted_at) return item;
      for (const lane of lanes) {
        const list = nextByLane.get(lane.id) ?? [];
        const idx = list.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
          const meta = laneMeta.get(lane.id);
          return {
            ...item,
            lane_id: lane.id,
            lane_name: meta?.name ?? item.lane_name,
            lane_is_terminal: meta?.is_terminal ?? false,
            position: idx,
            completed_at: meta?.is_terminal
              ? item.completed_at ?? new Date().toISOString()
              : null,
          };
        }
      }
      return item;
    });
    qc.setQueryData(["abTestItems"], renumbered);
    layoutMutation.mutate(buildLayoutPayload(lanes, nextByLane));
  }

  function handleDragStart(e: DragStartEvent) {
    const type =
      (e.active.data.current?.type as "ticket" | "lane" | undefined) ?? "ticket";
    activeDragTypeRef.current = type;
    setActiveDragType(type);
    if (type === "lane") {
      setActiveId(
        String(e.active.data.current?.laneId ?? parseLaneSortableId(String(e.active.id))),
      );
      laneSnapshotRef.current =
        qc.getQueryData<AbTestBoardLane[]>(["abTestBoardLanes"]) ?? null;
    } else {
      setActiveId(String(e.active.id));
      dragSnapshotRef.current =
        qc.getQueryData<AbTestItem[]>(["abTestItems"]) ?? null;
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    const type = activeDragTypeRef.current;
    activeDragTypeRef.current = null;
    setActiveId(null);
    setActiveDragType(null);

    if (type === "lane") {
      const snapshot = laneSnapshotRef.current;
      laneSnapshotRef.current = null;
      if (!isAdmin || !snapshot) {
        if (snapshot) qc.setQueryData(["abTestBoardLanes"], snapshot);
        return;
      }
      const { active, over } = e;
      if (!over) {
        qc.setQueryData(["abTestBoardLanes"], snapshot);
        return;
      }
      const activeLaneId =
        (active.data.current?.laneId as string | undefined) ??
        parseLaneSortableId(String(active.id));
      const overLaneId = resolveLaneIdFromOver(
        String(over.id),
        over.data.current as { laneId?: string } | undefined,
        snapshot,
        qc.getQueryData<AbTestItem[]>(["abTestItems"]) ?? [],
      );
      if (!activeLaneId || !overLaneId || activeLaneId === overLaneId) return;

      const ids = snapshot.map((l) => l.id);
      const from = ids.indexOf(activeLaneId);
      const to = ids.indexOf(overLaneId);
      if (from < 0 || to < 0) return;
      const next = arrayMove(ids, from, to);
      qc.setQueryData<AbTestBoardLane[]>(["abTestBoardLanes"], (prev) => {
        if (!prev) return prev;
        const byId = new Map(prev.map((l) => [l.id, l]));
        return next.map((id, order) => ({ ...byId.get(id)!, order }));
      });
      reorderLanesMutation.mutate(next);
      return;
    }

    const snapshot = dragSnapshotRef.current;
    dragSnapshotRef.current = null;
    if (!canWrite || !snapshot) {
      if (snapshot) qc.setQueryData(["abTestItems"], snapshot);
      return;
    }

    const { active, over } = e;
    if (!over) {
      qc.setQueryData(["abTestItems"], snapshot);
      return;
    }

    const current = qc.getQueryData<AbTestItem[]>(["abTestItems"]) ?? snapshot;
    const { byLane } = partitionBoard(current, lanes);
    const activeItemId = String(active.id);
    const overId = String(over.id);
    const overLaneId =
      (over.data.current as { laneId?: string } | undefined)?.laneId ??
      parseLaneSortableId(overId) ??
      (overId.startsWith("col:") ? overId.slice("col:".length) : null);

    let fromLane: string | null = null;
    let fromIndex = -1;
    for (const lane of lanes) {
      const list = byLane.get(lane.id) ?? [];
      const idx = list.findIndex((i) => i.id === activeItemId);
      if (idx >= 0) {
        fromLane = lane.id;
        fromIndex = idx;
        break;
      }
    }
    if (!fromLane || fromIndex < 0) {
      qc.setQueryData(["abTestItems"], snapshot);
      return;
    }

    let toLane: string | null = null;
    let toIndex = 0;
    // Prefer dropping onto another ticket (insert at that index).
    for (const lane of lanes) {
      const list = byLane.get(lane.id) ?? [];
      const idx = list.findIndex((i) => i.id === overId);
      if (idx >= 0) {
        toLane = lane.id;
        toIndex = idx;
        break;
      }
    }
    // Empty column / column chrome / lane sortable wrapper → append.
    if (!toLane && overLaneId && byLane.has(overLaneId)) {
      toLane = overLaneId;
      toIndex = (byLane.get(toLane) ?? []).length;
    }
    if (!toLane) {
      qc.setQueryData(["abTestItems"], snapshot);
      return;
    }

    const next = new Map<string, AbTestItem[]>();
    for (const lane of lanes) next.set(lane.id, [...(byLane.get(lane.id) ?? [])]);
    const fromList = next.get(fromLane)!;
    const [moved] = fromList.splice(fromIndex, 1);
    if (!moved) return;

    if (fromLane === toLane) {
      const adjusted = toIndex > fromIndex ? toIndex - 1 : toIndex;
      fromList.splice(adjusted, 0, moved);
      next.set(fromLane, fromList);
    } else {
      const toList = next.get(toLane)!;
      toList.splice(toIndex, 0, moved);
      next.set(fromLane, fromList);
      next.set(toLane, toList);
    }
    applyOptimisticLayout(next);
  }

  async function handleDelete(item: AbTestItem) {
    const ok = await confirm({
      title: "Delete experiment?",
      description: `“${item.name}” will be archived from the A/B Testing board.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    deleteMutation.mutate(item.id);
  }

  async function handleRenameLane(lane: AbTestBoardLane) {
    const next = await prompt({
      title: "Rename swim lane",
      description: "Shown as the column title on the A/B Testing board.",
      defaultValue: lane.name,
      confirmLabel: "Save",
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === lane.name) return;
    patchLaneMutation.mutate({ id: lane.id, name: trimmed });
  }

  async function handleDeleteLane(lane: AbTestBoardLane) {
    const ticketCount = (board.byLane.get(lane.id) ?? []).length;
    const dest = lanes.find((l) => l.id !== lane.id);
    const ok = await confirm({
      title: `Delete “${lane.name}”?`,
      description:
        ticketCount > 0
          ? `${ticketCount} experiment${ticketCount === 1 ? "" : "s"} will move to “${dest?.name ?? "another column"}”.`
          : "This removes the column from the board. You can add it again later.",
      confirmLabel: "Delete lane",
      destructive: true,
    });
    if (!ok) return;
    deleteLaneMutation.mutate(lane.id);
  }

  if (!items.isFetched || !lanesQuery.isFetched) {
    return <div className="p-6 text-sm text-wp-slate">Loading A/B tests…</div>;
  }

  const activeItem =
    activeDragType === "ticket"
      ? (items.data ?? []).find((i) => i.id === activeId) ?? null
      : null;
  const activeLane =
    activeDragType === "lane" ? lanes.find((l) => l.id === activeId) ?? null : null;

  const laneSortableIds = lanes.map((l) => laneSortableId(l.id));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewPageHeader tabKey="ab_testing" />
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-2">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-wp-slate">
            {board.activeCount} experiment{board.activeCount === 1 ? "" : "s"} on the board
          </p>
          {canWrite ? (
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5"
              onClick={() => {
                createMutation.reset();
                setLaneId(defaultLaneId);
                setShowCreate(true);
              }}
            >
              <Plus size={14} />
              New experiment
            </button>
          ) : null}
        </div>

        <MutationErrorBanner
          mutation={
            layoutMutation.isError
              ? layoutMutation
              : patchMutation.isError
                ? patchMutation
                : deleteLaneMutation.isError
                  ? deleteLaneMutation
                  : deleteMutation
          }
          className="mb-2"
        />

        {showCreate ? (
          <KanbanItemCreateModal
            title="New A/B test"
            onClose={() => {
              createMutation.reset();
              setShowCreate(false);
            }}
            name={name}
            onNameChange={setName}
            description={description}
            onDescriptionChange={setDescription}
            teamId={teamId}
            onTeamIdChange={setTeamId}
            teamOptions={teamOptions}
            canSubmit={name.trim().length > 0}
            onSubmit={() => createMutation.mutate()}
            mutation={createMutation}
            nameFieldId="ab-name"
            descriptionFieldId="ab-desc"
            extraFields={
              <>
                <div className="min-w-[180px]">
                  <label className="text-xs font-medium text-wp-slate" htmlFor="ab-assign">
                    Assigned to
                  </label>
                  <select
                    id="ab-assign"
                    className="input mt-1 w-full"
                    value={assignedTo}
                    onChange={(e) => setAssignedTo(e.target.value)}
                  >
                    <option value="">— Unassigned —</option>
                    {userOptions.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[180px]">
                  <label className="text-xs font-medium text-wp-slate" htmlFor="ab-lane">
                    Stage
                  </label>
                  <select
                    id="ab-lane"
                    className="input mt-1 w-full"
                    value={laneId || defaultLaneId}
                    onChange={(e) => setLaneId(e.target.value)}
                  >
                    {lanes.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            }
          />
        ) : null}

        {showAddLane ? (
          <AddLaneDialog
            pending={createLaneMutation.isPending}
            onClose={() => {
              createLaneMutation.reset();
              setShowAddLane(false);
            }}
            onCreate={(body) => createLaneMutation.mutate(body)}
          />
        ) : null}

        <DndContext
          sensors={sensors}
          collisionDetection={boardCollision}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            if (activeDragTypeRef.current === "lane" && laneSnapshotRef.current) {
              qc.setQueryData(["abTestBoardLanes"], laneSnapshotRef.current);
            }
            if (activeDragTypeRef.current === "ticket" && dragSnapshotRef.current) {
              qc.setQueryData(["abTestItems"], dragSnapshotRef.current);
            }
            dragSnapshotRef.current = null;
            laneSnapshotRef.current = null;
            activeDragTypeRef.current = null;
            setActiveId(null);
            setActiveDragType(null);
          }}
        >
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
            <SortableContext items={laneSortableIds} strategy={horizontalListSortingStrategy}>
              {lanes.map((lane) => (
                <SortableStageColumn
                  key={lane.id}
                  lane={lane}
                  items={board.byLane.get(lane.id) ?? []}
                  canWrite={canWrite}
                  isAdmin={isAdmin}
                  selectedId={selectedId}
                  onOpen={setSelectedId}
                  onRename={() => void handleRenameLane(lane)}
                  onDeleteLane={() => void handleDeleteLane(lane)}
                />
              ))}
            </SortableContext>
            {isAdmin ? (
              <button
                type="button"
                className="flex h-[72px] w-12 shrink-0 items-center justify-center self-start rounded-xl border border-dashed border-wp-stone bg-white/60 text-wp-slate transition hover:border-wp-red/40 hover:bg-white hover:text-wp-red"
                title="Add swim lane"
                aria-label="Add swim lane"
                onClick={() => {
                  createLaneMutation.reset();
                  setShowAddLane(true);
                }}
              >
                <Plus size={20} />
              </button>
            ) : null}
          </div>
          <DragOverlay>
            {activeItem ? (
              <TicketCard item={activeItem} index={1} dragging />
            ) : activeLane ? (
              <div className="flex w-[280px] items-center gap-2 rounded-xl border border-wp-stone bg-white px-3 py-3 shadow-lg">
                <span className="text-sm font-semibold text-wp-ink">{activeLane.name}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {selectedItem ? (
          <AbTestDetailPanel
            item={selectedItem}
            onClose={() => setSelectedId(null)}
            onOpenTicket={setSelectedId}
            siblingIds={siblingIds}
            canWrite={canWrite}
            canDelete={canWrite}
            patchPending={patchMutation.isPending}
            onPatch={(id, body) => patchMutation.mutate({ id, body })}
            onDelete={() => handleDelete(selectedItem)}
            userOptions={userOptions}
            teamOptions={teamOptions}
            lanes={lanes}
          />
        ) : null}
      </div>
    </div>
  );
}

function AddLaneDialog({
  pending,
  onClose,
  onCreate,
}: {
  pending: boolean;
  onClose: () => void;
  onCreate: (body: { name: string; is_terminal: boolean }) => void;
}) {
  const [name, setName] = useState("");
  const [isTerminal, setIsTerminal] = useState(false);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="card-surface w-full max-w-sm space-y-4 p-5 shadow-xl"
        role="dialog"
        aria-labelledby="add-ab-lane-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 id="add-ab-lane-title" className="text-base font-semibold text-wp-ink">
            Add swim lane
          </h2>
          <p className="mt-1 text-xs text-wp-slate">
            New columns are added on the right. Drag the grip to reorder.
          </p>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-wp-slate">Name</span>
          <input
            className="input mt-1 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={256}
            autoFocus
            placeholder="e.g. QA review"
          />
        </label>
        <label className="flex items-start gap-2 text-xs text-wp-slate">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={isTerminal}
            onChange={(e) => setIsTerminal(e.target.checked)}
          />
          <span>Archive column — cards here count as complete (strikethrough).</span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!name.trim() || pending}
            onClick={() => onCreate({ name: name.trim(), is_terminal: isTerminal })}
          >
            {pending ? "Adding…" : "Add lane"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SortableStageColumn({
  lane,
  items,
  canWrite,
  isAdmin,
  selectedId,
  onOpen,
  onRename,
  onDeleteLane,
}: {
  lane: AbTestBoardLane;
  items: AbTestItem[];
  canWrite: boolean;
  isAdmin: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onRename: () => void;
  onDeleteLane: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: laneSortableId(lane.id),
    data: { type: "lane", laneId: lane.id },
    disabled: !isAdmin,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="w-[280px] shrink-0">
      <StageColumn
        lane={lane}
        items={items}
        canWrite={canWrite}
        isAdmin={isAdmin}
        selectedId={selectedId}
        onOpen={onOpen}
        onRename={onRename}
        onDeleteLane={onDeleteLane}
        laneDragHandle={
          isAdmin ? { attributes, listeners } : undefined
        }
      />
    </div>
  );
}

function StageColumn({
  lane,
  items,
  canWrite,
  isAdmin,
  selectedId,
  onOpen,
  onRename,
  onDeleteLane,
  laneDragHandle,
}: {
  lane: AbTestBoardLane;
  items: AbTestItem[];
  canWrite: boolean;
  isAdmin: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onRename: () => void;
  onDeleteLane: () => void;
  laneDragHandle?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attributes: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listeners: any;
  };
}) {
  const droppableId = `col:${lane.id}`;
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    data: { laneId: lane.id },
  });

  return (
    <section
      className={cn(
        "flex w-[280px] shrink-0 flex-col rounded-xl border border-wp-stone/80 bg-wp-stone/25",
        isOver && "ring-2 ring-wp-red/30",
      )}
    >
      <header className="flex items-start gap-1 px-2 py-3">
        {laneDragHandle ? (
          <button
            type="button"
            className="btn-ghost !p-1 cursor-grab touch-none text-wp-slate hover:text-wp-ink active:cursor-grabbing"
            title="Drag to reorder swim lane"
            aria-label={`Reorder ${lane.name}`}
            {...laneDragHandle.attributes}
            {...laneDragHandle.listeners}
          >
            <GripVertical size={16} />
          </button>
        ) : null}
        <h2 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-wp-ink">
          {lane.name}
        </h2>
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-white px-1.5 text-[11px] font-semibold text-wp-slate shadow-sm">
          {items.length}
        </span>
        {isAdmin ? (
          <>
            <button
              type="button"
              className="btn-ghost !p-1 text-wp-slate hover:text-wp-ink"
              title={`Rename ${lane.name}`}
              aria-label={`Rename ${lane.name}`}
              onClick={onRename}
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              className="btn-ghost !p-1 text-wp-slate hover:text-red-600"
              title={`Delete ${lane.name}`}
              aria-label={`Delete ${lane.name}`}
              onClick={onDeleteLane}
            >
              <Trash2 size={13} />
            </button>
          </>
        ) : null}
      </header>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
        >
          {items.map((item, idx) => (
            <SortableTicket
              key={item.id}
              item={item}
              index={idx + 1}
              selected={selectedId === item.id}
              canWrite={canWrite}
              onOpen={() => onOpen(item.id)}
            />
          ))}
          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-wp-stone bg-white/50 px-3 py-8 text-center text-xs text-wp-slate">
              Nothing here yet
            </div>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableTicket({
  item,
  index,
  selected,
  canWrite,
  onOpen,
}: {
  item: AbTestItem;
  index: number;
  selected: boolean;
  canWrite: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { type: "ticket", laneId: item.lane_id },
    disabled: !canWrite,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <TicketCard
        item={item}
        index={index}
        selected={selected}
        dragProps={canWrite ? { ...attributes, ...listeners } : undefined}
        onOpen={onOpen}
      />
    </div>
  );
}

function TicketCard({
  item,
  index,
  selected,
  dragProps,
  onOpen,
  dragging,
}: {
  item: AbTestItem;
  index: number;
  selected?: boolean;
  dragProps?: Record<string, unknown>;
  onOpen?: () => void;
  dragging?: boolean;
}) {
  const done = item.lane_is_terminal;
  const stubLabel = `No.${String(index).padStart(2, "0")}`;

  return (
    <article
      className={cn(
        "flex overflow-hidden rounded-lg border border-wp-stone bg-white shadow-sm",
        dragging && "shadow-lg ring-2 ring-wp-red/20",
        selected && "ring-2 ring-wp-red/35",
      )}
    >
      <div
        className={cn(
          "flex w-7 shrink-0 flex-col items-center justify-center border-r border-dashed border-wp-stone bg-wp-stone/30",
          dragProps && "cursor-grab active:cursor-grabbing",
        )}
        {...(dragProps ?? {})}
        title={dragProps ? "Drag to move" : undefined}
      >
        <span
          className="select-none text-[9px] font-semibold uppercase tracking-wider text-wp-slate"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {stubLabel}
        </span>
      </div>
      <button
        type="button"
        className="min-w-0 flex-1 px-3 py-2.5 text-left"
        onClick={onOpen}
        disabled={!onOpen}
      >
        <div className="flex items-start gap-2">
          <h3
            className={cn(
              "min-w-0 flex-1 text-sm font-semibold leading-snug text-wp-ink",
              done && "text-wp-slate line-through",
            )}
          >
            {item.name}
          </h3>
          {item.assignee_name ? (
            <UserAvatar name={item.assignee_name} color="#94a3b8" size={22} />
          ) : null}
        </div>
        {item.description.trim() ? (
          <p className="mt-1 line-clamp-2 text-xs italic leading-relaxed text-wp-slate">
            {item.description.trim()}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.jira_key ? (
            <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
              {item.jira_key}
            </span>
          ) : null}
          {item.team_name ? (
            <span className="chip text-[10px]">{item.team_name}</span>
          ) : null}
        </div>
        {(item.due_date || item.is_blocked) ? (
          <div className="mt-2 flex items-center justify-between text-xs text-wp-slate">
            <div className="flex items-center gap-2">
              {item.due_date ? (
                <span className="inline-flex items-center gap-1">
                  <Calendar size={11} />
                  {format(new Date(`${item.due_date}T00:00:00`), "MMM d")}
                </span>
              ) : null}
            </div>
            {item.is_blocked ? (
              <span
                className="relative inline-flex size-3.5 items-center justify-center text-red-700"
                title={
                  item.blocked_reason?.trim()
                    ? `Blocked: ${item.blocked_reason.trim()}`
                    : "Blocked"
                }
              >
                <Octagon size={14} className="fill-red-600 text-red-700" />
                <X
                  size={8}
                  strokeWidth={3}
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white"
                  aria-hidden
                />
              </span>
            ) : null}
          </div>
        ) : null}
      </button>
    </article>
  );
}
