import { useMemo, useRef, useState, type ReactNode } from "react";
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
import {
  Check,
  GripVertical,
  HelpCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { KanbanItemCreateModal } from "../components/KanbanItemCreateModal";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { UserAvatar } from "../components/UserAvatar";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { useAppDialog } from "../components/AppDialogProvider";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  useCanWrite,
  useDesignBoardLanes,
  useDesignItems,
  useIsAdmin,
  useMentionableUsers,
  useTeams,
  type MentionableUser,
} from "../lib/queries";
import type { DesignBoardLane, DesignItem, DesignTicketStatus } from "../lib/types";

const UNASSIGNED_COL = "col:unassigned";
const COMPLETED_COL = "col:completed";

type ColumnKey = string; // user uuid | UNASSIGNED_COL | COMPLETED_COL

type PersonColumnUser = MentionableUser & { laneId: string };

const TICKET_STATUS_META: Record<
  DesignTicketStatus,
  { label: string; className: string }
> = {
  not: {
    label: "Not started",
    className: "bg-wp-stone/60 text-wp-slate border-wp-stone",
  },
  on: {
    label: "On-track",
    className: "bg-sky-50 text-sky-800 border-sky-200",
  },
  risk: {
    label: "At Risk",
    className: "bg-red-50 text-red-800 border-red-200",
  },
  review: {
    label: "In Review",
    className: "bg-violet-50 text-violet-800 border-violet-200",
  },
  indev: {
    label: "In Development",
    className: "bg-teal-50 text-teal-800 border-teal-200",
  },
  done: {
    label: "Completed",
    className: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
};

function laneSortableId(laneId: string) {
  return `lane:${laneId}`;
}

function parseLaneSortableId(id: string): string | null {
  return id.startsWith("lane:") ? id.slice("lane:".length) : null;
}

/** When dragging a lane, only collide with other lane sortables — nested
 *  ticket / column droppables otherwise steal the `over` target. */
const boardCollision: CollisionDetection = (args) => {
  if (args.active.data.current?.type === "lane") {
    const laneContainers = args.droppableContainers.filter((c) =>
      String(c.id).startsWith("lane:"),
    );
    return closestCenter({ ...args, droppableContainers: laneContainers });
  }
  return closestCorners(args);
};

function resolveLaneIdFromOver(
  overId: string,
  overData: { laneId?: string } | null | undefined,
  lanes: DesignBoardLane[],
  items: DesignItem[],
): string | null {
  if (overData?.laneId) return overData.laneId;
  const fromPrefix = parseLaneSortableId(overId);
  if (fromPrefix) return fromPrefix;
  if (overId.startsWith("col:user:")) {
    const userId = overId.slice("col:user:".length);
    return lanes.find((l) => l.user_id === userId)?.id ?? null;
  }
  const ticket = items.find((i) => i.id === overId);
  if (ticket?.assigned_to) {
    return lanes.find((l) => l.user_id === ticket.assigned_to)?.id ?? null;
  }
  return null;
}

function colKeyForItem(item: DesignItem, laneUserIds: Set<string>): ColumnKey {
  if (item.status === "completed") return COMPLETED_COL;
  if (!item.assigned_to || !laneUserIds.has(item.assigned_to)) return UNASSIGNED_COL;
  return item.assigned_to;
}

function isActiveStatus(status: DesignItem["status"]) {
  return status === "next_up" || status === "in_design";
}

function partitionBoard(
  items: DesignItem[],
  lanes: DesignBoardLane[],
  roster: MentionableUser[],
) {
  const laneUserIds = new Set(lanes.map((l) => l.user_id));
  const active = items.filter((i) => isActiveStatus(i.status));
  const completed = items
    .filter((i) => i.status === "completed")
    .sort((a, b) => a.position - b.position || (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));

  const byAssignee = new Map<string | null, DesignItem[]>();
  for (const item of active) {
    // Assignees without a swim lane land in Unassigned for display.
    const key =
      item.assigned_to && laneUserIds.has(item.assigned_to) ? item.assigned_to : null;
    const list = byAssignee.get(key) ?? [];
    list.push(item);
    byAssignee.set(key, list);
  }
  for (const list of byAssignee.values()) {
    list.sort((a, b) => a.position - b.position);
  }

  const rosterById = new Map(roster.map((u) => [u.id, u]));
  const personColumns: PersonColumnUser[] = lanes.map((lane) => {
    const fromRoster = rosterById.get(lane.user_id);
    return {
      id: lane.user_id,
      laneId: lane.id,
      name: fromRoster?.name ?? lane.user_name,
      email: fromRoster?.email ?? lane.user_email,
      color: fromRoster?.color ?? lane.user_color ?? "#94a3b8",
    };
  });

  return {
    personColumns,
    laneUserIds,
    unassigned: byAssignee.get(null) ?? [],
    byAssignee,
    completed,
    activeCount: active.length,
    totalVisible: active.length + completed.length,
  };
}

type BoardLayoutBody = {
  columns: Array<{ assigned_to: string | null; item_ids: string[] }>;
  completed_ids: string[];
};

function buildLayoutPayload(
  personColumns: PersonColumnUser[],
  byAssignee: Map<string | null, DesignItem[]>,
  completed: DesignItem[],
): BoardLayoutBody {
  const columns: BoardLayoutBody["columns"] = [
    {
      assigned_to: null,
      item_ids: (byAssignee.get(null) ?? []).map((i) => i.id),
    },
    ...personColumns.map((u) => ({
      assigned_to: u.id,
      item_ids: (byAssignee.get(u.id) ?? []).map((i) => i.id),
    })),
  ];
  return {
    columns,
    completed_ids: completed.map((i) => i.id),
  };
}

/**
 * Product Design Tickets — person-column board (PRD).
 * Fed by Design Tab creates, roadmap design lanes, and Simple Features.
 * Admins manage the person swim lanes (add / reorder / delete).
 */
export function DesignView() {
  const items = useDesignItems();
  const lanesQuery = useDesignBoardLanes();
  const teams = useTeams();
  const mentionable = useMentionableUsers();
  const canWrite = useCanWrite();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const { confirm } = useAppDialog();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddLane, setShowAddLane] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDragType, setActiveDragType] = useState<"ticket" | "lane" | null>(null);
  const activeDragTypeRef = useRef<"ticket" | "lane" | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const dragSnapshotRef = useRef<DesignItem[] | null>(null);
  const laneSnapshotRef = useRef<DesignBoardLane[] | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamId, setTeamId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [ticketStatus, setTicketStatus] = useState<DesignTicketStatus>("not");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const all = items.data ?? [];
  const lanes = lanesQuery.data ?? [];
  const roster = mentionable.data ?? [];
  const board = useMemo(
    () => partitionBoard(all, lanes, roster),
    [all, lanes, roster],
  );
  const activeItem =
    activeDragType === "ticket" && activeId
      ? all.find((f) => f.id === activeId)
      : null;
  const activeLane =
    activeDragType === "lane" && activeId
      ? board.personColumns.find((c) => c.laneId === activeId)
      : null;

  const createMutation = useMutation({
    mutationFn: () =>
      api<DesignItem>("/design-items", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          team_id: teamId || null,
          assigned_to: assignedTo || null,
          ticket_status: ticketStatus,
        }),
      }),
    onSuccess: (row) => {
      setName("");
      setDescription("");
      setTeamId("");
      setAssignedTo("");
      setTicketStatus("not");
      setShowCreateModal(false);
      qc.setQueryData<DesignItem[]>(["designItems"], (prev) =>
        prev ? [row, ...prev.filter((f) => f.id !== row.id)] : [row],
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const patchMutation = useMutation({
    mutationFn: (v: {
      id: string;
      body: Partial<
        Pick<
          DesignItem,
          "name" | "description" | "team_id" | "assigned_to" | "ticket_status" | "jira_key" | "links"
        >
      >;
    }) =>
      api<DesignItem>(`/design-items/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify(v.body),
      }),
    onSuccess: (row) => {
      qc.setQueryData<DesignItem[]>(["designItems"], (prev) =>
        prev ? prev.map((f) => (f.id === row.id ? row : f)) : [row],
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const boardLayoutMutation = useMutation({
    mutationFn: (body: BoardLayoutBody) =>
      api<DesignItem[]>("/design-items/board-layout", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (list) => qc.setQueryData(["designItems"], list),
    onError: () => {
      if (dragSnapshotRef.current) {
        qc.setQueryData(["designItems"], dragSnapshotRef.current);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/design-items/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const createLaneMutation = useMutation({
    mutationFn: (user_id: string) =>
      api<DesignBoardLane>("/design-board-lanes", {
        method: "POST",
        body: JSON.stringify({ user_id }),
      }),
    onSuccess: () => {
      setShowAddLane(false);
      qc.invalidateQueries({ queryKey: ["designBoardLanes"] });
    },
  });

  const reorderLanesMutation = useMutation({
    mutationFn: (order: string[]) =>
      api<DesignBoardLane[]>("/design-board-lanes/reorder", {
        method: "POST",
        body: JSON.stringify({ order }),
      }),
    onSuccess: (list) => qc.setQueryData(["designBoardLanes"], list),
    onError: () => {
      if (laneSnapshotRef.current) {
        qc.setQueryData(["designBoardLanes"], laneSnapshotRef.current);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["designBoardLanes"] }),
  });

  const deleteLaneMutation = useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: string; tickets_moved: number }>(`/design-board-lanes/${id}`, {
        method: "DELETE",
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["designBoardLanes"] });
      qc.invalidateQueries({ queryKey: ["designItems"] });
    },
  });

  function applyOptimisticMove(
    itemId: string,
    toCol: ColumnKey,
    overItemId: string | null,
  ) {
    const cache = qc.getQueryData<DesignItem[]>(["designItems"]);
    if (!cache) return null;

    const renumbered = cache.map((i) => ({ ...i }));
    const target = renumbered.find((i) => i.id === itemId);
    if (!target) return null;

    if (toCol === COMPLETED_COL) {
      target.status = "completed";
      target.ticket_status = "done";
      target.completed_at = target.completed_at ?? new Date().toISOString();
    } else {
      target.status = "in_design";
      target.completed_at = null;
      if (target.ticket_status === "done") target.ticket_status = "on";
      target.assigned_to = toCol === UNASSIGNED_COL ? null : toCol;
      const user = roster.find((u) => u.id === target.assigned_to);
      target.assignee_name =
        user?.name ?? (toCol === UNASSIGNED_COL ? null : target.assignee_name);
    }

    const part = partitionBoard(renumbered, lanes, roster);

    const applyOrder = (
      list: DesignItem[],
      status: DesignItem["status"],
      assigned: string | null,
    ) => {
      list.forEach((row, idx) => {
        const t = renumbered.find((x) => x.id === row.id);
        if (!t) return;
        t.position = idx;
        t.status = status;
        if (status !== "completed") {
          t.assigned_to = assigned;
          t.completed_at = null;
        }
      });
    };

    applyOrder(part.unassigned, "in_design", null);
    for (const u of part.personColumns) {
      applyOrder(part.byAssignee.get(u.id) ?? [], "in_design", u.id);
    }
    applyOrder(part.completed, "completed", null);

    const reorderWithin = (predicate: (i: DesignItem) => boolean) => {
      if (!overItemId || overItemId === itemId) return;
      const colItems = renumbered
        .filter(predicate)
        .sort((a, b) => a.position - b.position);
      const ids = colItems.map((i) => i.id);
      const from = ids.indexOf(itemId);
      const to = ids.indexOf(overItemId);
      if (from < 0 || to < 0 || from === to) return;
      arrayMove(ids, from, to).forEach((id, idx) => {
        const t = renumbered.find((x) => x.id === id);
        if (t) t.position = idx;
      });
    };

    if (toCol === COMPLETED_COL) {
      reorderWithin((i) => i.status === "completed");
    } else if (toCol === UNASSIGNED_COL) {
      reorderWithin(
        (i) =>
          isActiveStatus(i.status) &&
          (!i.assigned_to || !board.laneUserIds.has(i.assigned_to)),
      );
    } else {
      reorderWithin((i) => isActiveStatus(i.status) && i.assigned_to === toCol);
    }

    qc.setQueryData(["designItems"], renumbered);
    return renumbered;
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
        qc.getQueryData<DesignBoardLane[]>(["designBoardLanes"]) ?? null;
    } else {
      setActiveId(String(e.active.id));
      dragSnapshotRef.current =
        qc.getQueryData<DesignItem[]>(["designItems"]) ?? null;
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
        if (snapshot) qc.setQueryData(["designBoardLanes"], snapshot);
        return;
      }
      const { active, over } = e;
      if (!over) {
        qc.setQueryData(["designBoardLanes"], snapshot);
        return;
      }
      const activeLaneId =
        (active.data.current?.laneId as string | undefined) ??
        parseLaneSortableId(String(active.id));
      const overLaneId = resolveLaneIdFromOver(
        String(over.id),
        over.data.current as { laneId?: string } | undefined,
        snapshot,
        qc.getQueryData<DesignItem[]>(["designItems"]) ?? [],
      );
      if (!activeLaneId || !overLaneId || activeLaneId === overLaneId) {
        return;
      }

      const ids = snapshot.map((l) => l.id);
      const from = ids.indexOf(activeLaneId);
      const to = ids.indexOf(overLaneId);
      if (from < 0 || to < 0) return;
      const next = arrayMove(ids, from, to);
      qc.setQueryData<DesignBoardLane[]>(["designBoardLanes"], (prev) => {
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
      if (snapshot) qc.setQueryData(["designItems"], snapshot);
      return;
    }

    const { active, over } = e;
    if (!over) {
      qc.setQueryData(["designItems"], snapshot);
      return;
    }

    // Ignore drops onto lane chrome.
    if (parseLaneSortableId(String(over.id))) {
      qc.setQueryData(["designItems"], snapshot);
      return;
    }

    const itemId = String(active.id);
    const overId = String(over.id);

    let toCol: ColumnKey;
    let overItemId: string | null = null;
    if (overId === UNASSIGNED_COL || overId === COMPLETED_COL || overId.startsWith("col:user:")) {
      toCol = overId.startsWith("col:user:") ? overId.slice("col:user:".length) : overId;
    } else {
      const overItem = (qc.getQueryData<DesignItem[]>(["designItems"]) ?? snapshot).find(
        (i) => i.id === overId,
      );
      if (!overItem) {
        qc.setQueryData(["designItems"], snapshot);
        return;
      }
      toCol = colKeyForItem(overItem, board.laneUserIds);
      overItemId = overItem.id;
    }

    const moved = applyOptimisticMove(itemId, toCol, overItemId === itemId ? null : overItemId);
    if (!moved) {
      qc.setQueryData(["designItems"], snapshot);
      return;
    }

    const part = partitionBoard(moved, lanes, roster);
    const payload = buildLayoutPayload(part.personColumns, part.byAssignee, part.completed);
    boardLayoutMutation.mutate(payload);
  }

  async function handleDelete(row: DesignItem) {
    if (
      !(await confirm({
        title: `Delete "${row.name}"?`,
        description: "Removed from the board. Deleted items are not shown on person columns.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    deleteMutation.mutate(row.id);
  }

  async function handleDeleteLane(col: PersonColumnUser) {
    const ticketCount = (board.byAssignee.get(col.id) ?? []).length;
    if (
      !(await confirm({
        title: `Delete ${col.name}'s swim lane?`,
        description:
          ticketCount > 0
            ? `${ticketCount} active ticket${ticketCount === 1 ? "" : "s"} will move to the top of Unassigned. Completed tickets keep their assignee for history, but this column will disappear.`
            : "This removes the column from the board. You can add it again later.",
        confirmLabel: "Delete lane",
        destructive: true,
      }))
    ) {
      return;
    }
    deleteLaneMutation.mutate(col.laneId);
  }

  if (!items.isFetched || !lanesQuery.isFetched) {
    return <div className="p-6 text-sm text-wp-slate">Loading design tickets…</div>;
  }

  const teamOptions = teams.data ?? [];
  const userOptions = roster;
  const laneUserIds = board.laneUserIds;
  const availableLaneUsers = roster.filter((u) => !laneUserIds.has(u.id));
  const laneSortableIds = board.personColumns.map((c) => laneSortableId(c.laneId));

  return (
    <div className="flex h-full flex-col overflow-hidden bg-wp-bg">
      <ViewPageHeader tabKey="design" />
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full flex-col gap-3 p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-xs text-wp-slate">
              Columns are people (plus Unassigned and Completed). Drag tickets to reassign or finish.
              {isAdmin
                ? " Admins can drag swim lanes to reorder, add a lane with +, or delete a lane."
                : " Card status is separate — use the pill on each ticket."}
            </p>
            <div className="flex items-center gap-3">
              <span className="text-xs text-wp-slate">
                Total tickets: <span className="font-semibold text-wp-ink">{board.totalVisible}</span>
              </span>
              {canWrite ? (
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-1.5"
                  onClick={() => {
                    createMutation.reset();
                    setName("");
                    setDescription("");
                    setTeamId("");
                    setAssignedTo("");
                    setTicketStatus("not");
                    setShowCreateModal(true);
                  }}
                >
                  <Plus size={15} />
                  New ticket
                </button>
              ) : null}
            </div>
          </div>

          <MutationErrorBanner mutation={patchMutation} />
          <MutationErrorBanner mutation={boardLayoutMutation} />
          <MutationErrorBanner mutation={deleteMutation} />
          <MutationErrorBanner mutation={createLaneMutation} />
          <MutationErrorBanner mutation={reorderLanesMutation} />
          <MutationErrorBanner mutation={deleteLaneMutation} />

          {showCreateModal ? (
            <KanbanItemCreateModal
              title="New design ticket"
              onClose={() => {
                createMutation.reset();
                setShowCreateModal(false);
              }}
              name={name}
              onNameChange={setName}
              description={description}
              onDescriptionChange={setDescription}
              teamId={teamId}
              onTeamIdChange={setTeamId}
              teamOptions={teamOptions}
              nameFieldId="di-name"
              descriptionFieldId="di-desc"
              mutation={createMutation}
              canSubmit={name.trim().length > 0}
              onSubmit={() => createMutation.mutate()}
              extraFields={
                <>
                  <div className="min-w-[180px]">
                    <label className="text-xs font-medium text-wp-slate" htmlFor="di-assign">
                      Assigned to
                    </label>
                    <select
                      id="di-assign"
                      className="input mt-1 w-full"
                      value={assignedTo}
                      onChange={(e) => setAssignedTo(e.target.value)}
                    >
                      <option value="">— Unassigned —</option>
                      {board.personColumns.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="min-w-[160px]">
                    <label className="text-xs font-medium text-wp-slate" htmlFor="di-tstatus">
                      Status
                    </label>
                    <select
                      id="di-tstatus"
                      className="input mt-1 w-full"
                      value={ticketStatus}
                      onChange={(e) => setTicketStatus(e.target.value as DesignTicketStatus)}
                    >
                      {(Object.keys(TICKET_STATUS_META) as DesignTicketStatus[]).map((k) => (
                        <option key={k} value={k}>
                          {TICKET_STATUS_META[k].label}
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
              users={availableLaneUsers}
              pending={createLaneMutation.isPending}
              onClose={() => {
                createLaneMutation.reset();
                setShowAddLane(false);
              }}
              onPick={(userId) => createLaneMutation.mutate(userId)}
            />
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={boardCollision}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              if (activeDragTypeRef.current === "lane" && laneSnapshotRef.current) {
                qc.setQueryData(["designBoardLanes"], laneSnapshotRef.current);
              }
              if (activeDragTypeRef.current === "ticket" && dragSnapshotRef.current) {
                qc.setQueryData(["designItems"], dragSnapshotRef.current);
              }
              dragSnapshotRef.current = null;
              laneSnapshotRef.current = null;
              activeDragTypeRef.current = null;
              setActiveId(null);
              setActiveDragType(null);
            }}
          >
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
              <PersonColumn
                droppableId={UNASSIGNED_COL}
                title="Unassigned"
                count={board.unassigned.length}
                items={board.unassigned}
                avatar={
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-sky-100 text-sky-700">
                    <HelpCircle size={15} />
                  </span>
                }
                canWrite={canWrite}
                expandedId={expandedId}
                onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
                onPatch={(id, body) => patchMutation.mutate({ id, body })}
                onDelete={handleDelete}
                patchPending={patchMutation.isPending}
                userOptions={userOptions}
                teamOptions={teamOptions}
                footer="Assign someone — or drag a ticket here to clear ownership."
              />

              <SortableContext items={laneSortableIds} strategy={horizontalListSortingStrategy}>
                {board.personColumns.map((user) => (
                  <SortablePersonColumn
                    key={user.laneId}
                    user={user}
                    droppableId={`col:user:${user.id}`}
                    count={(board.byAssignee.get(user.id) ?? []).length}
                    items={board.byAssignee.get(user.id) ?? []}
                    canWrite={canWrite}
                    isAdmin={isAdmin}
                    expandedId={expandedId}
                    onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
                    onPatch={(id, body) => patchMutation.mutate({ id, body })}
                    onDelete={handleDelete}
                    onDeleteLane={() => handleDeleteLane(user)}
                    patchPending={patchMutation.isPending}
                    userOptions={userOptions}
                    teamOptions={teamOptions}
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

              <PersonColumn
                droppableId={COMPLETED_COL}
                title="Completed"
                count={board.completed.length}
                items={board.completed}
                avatar={
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <Check size={15} strokeWidth={2.5} />
                  </span>
                }
                canWrite={canWrite}
                expandedId={expandedId}
                onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
                onPatch={(id, body) => patchMutation.mutate({ id, body })}
                onDelete={handleDelete}
                patchPending={patchMutation.isPending}
                userOptions={userOptions}
                teamOptions={teamOptions}
                footer="Drag here to complete. Assignee is kept for history."
                completedColumn
              />
            </div>
            <DragOverlay>
              {activeItem ? (
                <TicketCard
                  item={activeItem}
                  index={1}
                  expanded={false}
                  canWrite={false}
                  dragging
                />
              ) : activeLane ? (
                <div className="flex w-[280px] items-center gap-2 rounded-xl border border-wp-stone bg-white px-3 py-3 shadow-lg">
                  <UserAvatar name={activeLane.name} color={activeLane.color} size={28} />
                  <span className="text-sm font-semibold text-wp-ink">{activeLane.name}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>
    </div>
  );
}

function AddLaneDialog({
  users,
  pending,
  onClose,
  onPick,
}: {
  users: MentionableUser[];
  pending: boolean;
  onClose: () => void;
  onPick: (userId: string) => void;
}) {
  const [selected, setSelected] = useState("");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="card-surface w-full max-w-sm space-y-4 p-5 shadow-xl"
        role="dialog"
        aria-labelledby="add-lane-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 id="add-lane-title" className="text-base font-semibold text-wp-ink">
            Add swim lane
          </h2>
          <p className="mt-1 text-xs text-wp-slate">
            Choose a user who doesn't already have a column on this board.
          </p>
        </div>
        {users.length === 0 ? (
          <p className="rounded-md border border-wp-stone bg-wp-stone/20 px-3 py-2 text-xs text-wp-slate">
            Every user in this group already has a swim lane.
          </p>
        ) : (
          <label className="block">
            <span className="text-xs font-medium text-wp-slate">User</span>
            <select
              className="input mt-1 w-full"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              autoFocus
            >
              <option value="">Select a user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!selected || pending}
            onClick={() => onPick(selected)}
          >
            {pending ? "Adding…" : "Add lane"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SortablePersonColumn({
  user,
  droppableId,
  count,
  items,
  canWrite,
  isAdmin,
  expandedId,
  onToggleExpand,
  onPatch,
  onDelete,
  onDeleteLane,
  patchPending,
  userOptions,
  teamOptions,
}: {
  user: PersonColumnUser;
  droppableId: string;
  count: number;
  items: DesignItem[];
  canWrite: boolean;
  isAdmin: boolean;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onPatch: (
    id: string,
    body: Partial<
      Pick<
        DesignItem,
        "name" | "description" | "team_id" | "assigned_to" | "ticket_status" | "jira_key" | "links"
      >
    >,
  ) => void;
  onDelete: (row: DesignItem) => void;
  onDeleteLane: () => void;
  patchPending: boolean;
  userOptions: MentionableUser[];
  teamOptions: { id: string; name: string }[];
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: laneSortableId(user.laneId),
    data: { type: "lane", laneId: user.laneId },
    disabled: !isAdmin,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="w-[280px] shrink-0">
      <PersonColumn
        droppableId={droppableId}
        title={user.name}
        count={count}
        items={items}
        avatar={<UserAvatar name={user.name} color={user.color} size={28} />}
        canWrite={canWrite}
        isAdmin={isAdmin}
        expandedId={expandedId}
        onToggleExpand={onToggleExpand}
        onPatch={onPatch}
        onDelete={onDelete}
        onDeleteLane={onDeleteLane}
        patchPending={patchPending}
        userOptions={userOptions}
        teamOptions={teamOptions}
        laneDragHandle={
          isAdmin
            ? {
                attributes,
                listeners,
              }
            : undefined
        }
      />
    </div>
  );
}

function PersonColumn({
  droppableId,
  title,
  count,
  items,
  avatar,
  canWrite,
  isAdmin = false,
  expandedId,
  onToggleExpand,
  onPatch,
  onDelete,
  onDeleteLane,
  patchPending,
  userOptions,
  teamOptions,
  footer,
  completedColumn = false,
  laneDragHandle,
}: {
  droppableId: string;
  title: string;
  count: number;
  items: DesignItem[];
  avatar: ReactNode;
  canWrite: boolean;
  isAdmin?: boolean;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onPatch: (
    id: string,
    body: Partial<
      Pick<
        DesignItem,
        "name" | "description" | "team_id" | "assigned_to" | "ticket_status" | "jira_key" | "links"
      >
    >,
  ) => void;
  onDelete: (row: DesignItem) => void;
  onDeleteLane?: () => void;
  patchPending: boolean;
  userOptions: MentionableUser[];
  teamOptions: { id: string; name: string }[];
  footer?: string;
  completedColumn?: boolean;
  laneDragHandle?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attributes: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listeners: any;
  };
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  return (
    <section
      className={cn(
        "flex w-[280px] shrink-0 flex-col rounded-xl border border-wp-stone/80 bg-wp-stone/25",
        isOver && "ring-2 ring-wp-red/30",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-3">
        {laneDragHandle ? (
          <button
            type="button"
            className="btn-ghost !p-1 cursor-grab touch-none text-wp-slate hover:text-wp-ink active:cursor-grabbing"
            title="Drag to reorder swim lane"
            aria-label={`Reorder ${title}`}
            {...laneDragHandle.attributes}
            {...laneDragHandle.listeners}
          >
            <GripVertical size={16} />
          </button>
        ) : null}
        {avatar}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-wp-ink">{title}</h2>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1.5 text-[11px] font-semibold text-wp-slate shadow-sm">
          {count}
        </span>
        {isAdmin && onDeleteLane ? (
          <button
            type="button"
            className="btn-ghost !p-1 text-wp-slate hover:text-red-600"
            title={`Delete ${title}'s swim lane`}
            aria-label={`Delete ${title}'s swim lane`}
            onClick={onDeleteLane}
          >
            <Trash2 size={13} />
          </button>
        ) : null}
      </header>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {items.map((item, idx) => (
            <SortableTicket
              key={item.id}
              item={item}
              index={idx + 1}
              expanded={expandedId === item.id}
              canWrite={canWrite && !completedColumn}
              canWriteCompleted={canWrite && completedColumn}
              onToggleExpand={() => onToggleExpand(item.id)}
              onPatch={onPatch}
              onDelete={() => onDelete(item)}
              patchPending={patchPending}
              userOptions={userOptions}
              teamOptions={teamOptions}
            />
          ))}
          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-wp-stone bg-white/50 px-3 py-8 text-center text-xs text-wp-slate">
              Nothing here yet
            </div>
          ) : null}
        </div>
      </SortableContext>
      {footer ? (
        <p className="border-t border-wp-stone/60 px-3 py-2 text-[10px] leading-snug text-wp-slate">
          {footer}
        </p>
      ) : null}
    </section>
  );
}

function SortableTicket({
  item,
  index,
  expanded,
  canWrite,
  canWriteCompleted,
  onToggleExpand,
  onPatch,
  onDelete,
  patchPending,
  userOptions,
  teamOptions,
}: {
  item: DesignItem;
  index: number;
  expanded: boolean;
  canWrite: boolean;
  canWriteCompleted?: boolean;
  onToggleExpand: () => void;
  onPatch: (
    id: string,
    body: Partial<
      Pick<
        DesignItem,
        "name" | "description" | "team_id" | "assigned_to" | "ticket_status" | "jira_key" | "links"
      >
    >,
  ) => void;
  onDelete: () => void;
  patchPending: boolean;
  userOptions: MentionableUser[];
  teamOptions: { id: string; name: string }[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { type: "ticket" },
    disabled: !canWrite && !canWriteCompleted,
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
        expanded={expanded}
        canWrite={canWrite}
        canDelete={canWrite || !!canWriteCompleted}
        dragProps={canWrite || canWriteCompleted ? { ...attributes, ...listeners } : undefined}
        onToggleExpand={onToggleExpand}
        onPatch={onPatch}
        onDelete={onDelete}
        patchPending={patchPending}
        userOptions={userOptions}
        teamOptions={teamOptions}
      />
    </div>
  );
}

function TicketCard({
  item,
  index,
  expanded,
  canWrite,
  canDelete,
  dragProps,
  onToggleExpand,
  onPatch,
  onDelete,
  patchPending,
  userOptions,
  teamOptions,
  dragging,
}: {
  item: DesignItem;
  index: number;
  expanded: boolean;
  canWrite: boolean;
  canDelete?: boolean;
  dragProps?: Record<string, unknown>;
  onToggleExpand?: () => void;
  onPatch?: (
    id: string,
    body: Partial<
      Pick<
        DesignItem,
        "name" | "description" | "team_id" | "assigned_to" | "ticket_status" | "jira_key" | "links"
      >
    >,
  ) => void;
  onDelete?: () => void;
  patchPending?: boolean;
  userOptions?: MentionableUser[];
  teamOptions?: { id: string; name: string }[];
  dragging?: boolean;
}) {
  const status = TICKET_STATUS_META[item.ticket_status] ?? TICKET_STATUS_META.not;
  const done = item.status === "completed" || item.ticket_status === "done";
  const stubLabel = `No.${String(index).padStart(2, "0")}`;

  const [editName, setEditName] = useState(item.name);
  const [editDesc, setEditDesc] = useState(item.description);
  const [editStatus, setEditStatus] = useState(item.ticket_status);
  const [editAssignee, setEditAssignee] = useState(item.assigned_to ?? "");
  const [editTeam, setEditTeam] = useState(item.team_id ?? "");
  const [editJira, setEditJira] = useState(item.jira_key ?? "");

  return (
    <article
      className={cn(
        "flex overflow-hidden rounded-lg border border-wp-stone bg-white shadow-sm",
        dragging && "shadow-lg ring-2 ring-wp-red/20",
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
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="w-full px-3 py-2.5 text-left"
          onClick={onToggleExpand}
          disabled={!onToggleExpand}
        >
          <h3
            className={cn(
              "text-sm font-semibold leading-snug text-wp-ink",
              done && "text-wp-slate line-through",
            )}
          >
            {item.name}
          </h3>
          {item.description.trim() ? (
            <p className="mt-1 line-clamp-2 text-xs italic leading-relaxed text-wp-slate">
              {item.description.trim()}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                status.className,
              )}
            >
              {status.label}
            </span>
            {item.jira_key ? (
              <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
                {item.jira_key}
              </span>
            ) : null}
            {item.team_name ? (
              <span className="chip text-[10px]">{item.team_name}</span>
            ) : null}
          </div>
          {(item.links ?? []).length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {item.links.map((l) => (
                <li key={`${l.label}-${l.url}`}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] font-medium text-wp-red hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </button>

        {expanded && canWrite && onPatch ? (
          <form
            className="space-y-2 border-t border-wp-stone px-3 py-2.5 text-xs"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              onPatch(item.id, {
                name: editName.trim(),
                description: editDesc.trim(),
                ticket_status: editStatus,
                assigned_to: editAssignee || null,
                team_id: editTeam || null,
                jira_key: editJira.trim() || null,
              });
            }}
          >
            <input
              className="input w-full text-sm"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
            />
            <textarea
              className="input min-h-[64px] w-full"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              rows={3}
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-wp-slate">Status</span>
                <select
                  className="input mt-0.5 w-full"
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as DesignTicketStatus)}
                >
                  {(Object.keys(TICKET_STATUS_META) as DesignTicketStatus[]).map((k) => (
                    <option key={k} value={k}>
                      {TICKET_STATUS_META[k].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-wp-slate">Assignee</span>
                <select
                  className="input mt-0.5 w-full"
                  value={editAssignee}
                  onChange={(e) => setEditAssignee(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {(userOptions ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-wp-slate">Product area</span>
                <select
                  className="input mt-0.5 w-full"
                  value={editTeam}
                  onChange={(e) => setEditTeam(e.target.value)}
                >
                  <option value="">—</option>
                  {(teamOptions ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-wp-slate">Jira key</span>
                <input
                  className="input mt-0.5 w-full"
                  value={editJira}
                  onChange={(e) => setEditJira(e.target.value)}
                  placeholder="FAL-1105"
                />
              </label>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <button type="submit" className="btn-primary text-xs" disabled={patchPending}>
                {patchPending ? "Saving…" : "Save"}
              </button>
              {canDelete && onDelete ? (
                <button
                  type="button"
                  className="btn-ghost !p-1.5 text-wp-slate hover:text-wp-red"
                  onClick={onDelete}
                  aria-label="Delete ticket"
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          </form>
        ) : null}
      </div>
    </article>
  );
}
