import { useCallback, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, ChevronDown, GripVertical, Map as MapIcon, Paintbrush, Plus, Trash2, User, Zap } from "lucide-react";
import { Collapsible } from "../components/Collapsible";
import { DesignAssignPromptModal } from "../components/DesignAssignPromptModal";
import { InfoTooltip } from "../components/InfoTooltip";
import { KanbanItemCreateModal } from "../components/KanbanItemCreateModal";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { useAppDialog } from "../components/AppDialogProvider";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  useCanWrite,
  useDesignItems,
  useMentionableUsers,
  useTeams,
} from "../lib/queries";
import type { DesignItem } from "../lib/types";

const BUCKET_NEXT = "bucket:next_up";
const BUCKET_DESIGN = "bucket:in_design";

type ActiveBucket = "next_up" | "in_design";

function bucketId(status: ActiveBucket): string {
  return status === "next_up" ? BUCKET_NEXT : BUCKET_DESIGN;
}

function statusFromBucket(id: string): ActiveBucket | null {
  if (id === BUCKET_NEXT) return "next_up";
  if (id === BUCKET_DESIGN) return "in_design";
  return null;
}

function partitionActive(items: DesignItem[]) {
  const next_up = items
    .filter((f) => f.status === "next_up")
    .sort((a, b) => a.position - b.position);
  const in_design = items
    .filter((f) => f.status === "in_design")
    .sort((a, b) => a.position - b.position);
  return { next_up, in_design };
}

function applyLayout(
  items: DesignItem[],
  nextUpIds: string[],
  inDesignIds: string[],
): DesignItem[] {
  const byId = new Map(items.map((f) => [f.id, f]));
  const next = [...items];
  for (let i = 0; i < nextUpIds.length; i++) {
    const id = nextUpIds[i];
    if (!id) continue;
    const row = byId.get(id);
    if (!row) continue;
    const idx = next.findIndex((f) => f.id === row.id);
    if (idx >= 0) next[idx] = { ...row, status: "next_up", position: i };
  }
  for (let i = 0; i < inDesignIds.length; i++) {
    const id = inDesignIds[i];
    if (!id) continue;
    const row = byId.get(id);
    if (!row) continue;
    const idx = next.findIndex((f) => f.id === row.id);
    if (idx >= 0) next[idx] = { ...row, status: "in_design", position: i };
  }
  return next;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Design kanban — fed by the Design tab, roadmap design lanes, and
 * Simple Features flagged needs_design.
 */
export function DesignView() {
  const items = useDesignItems();
  const teams = useTeams();
  const mentionable = useMentionableUsers();
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const { confirm } = useAppDialog();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragSnapshotRef = useRef<DesignItem[] | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamId, setTeamId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");

  type AssignPromptState = {
    item: DesignItem;
    nextUpIds: string[];
    inDesignIds: string[];
    snapshot: DesignItem[];
  };
  const [assignPrompt, setAssignPrompt] = useState<AssignPromptState | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const all = items.data ?? [];
  const { next_up, in_design } = partitionActive(all);
  const completed = all
    .filter((f) => f.status === "completed")
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  const deleted = all
    .filter((f) => f.status === "deleted")
    .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? ""));

  const activeItem = activeId ? all.find((f) => f.id === activeId) : null;

  const createMutation = useMutation({
    mutationFn: () =>
      api<DesignItem>("/design-items", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          team_id: teamId || null,
          assigned_to: assignedTo || null,
        }),
      }),
    onSuccess: (row) => {
      setName("");
      setDescription("");
      setTeamId("");
      setAssignedTo("");
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
      body: Partial<Pick<DesignItem, "name" | "description" | "team_id" | "assigned_to">>;
    }) =>
      api<DesignItem>(`/design-items/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify(v.body),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const layoutMutation = useMutation({
    mutationFn: (body: { next_up: string[]; in_design: string[] }) =>
      api<DesignItem[]>("/design-items/layout", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onError: () => {
      if (dragSnapshotRef.current) {
        qc.setQueryData(["designItems"], dragSnapshotRef.current);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) =>
      api<DesignItem>(`/design-items/${id}/complete`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/design-items/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const assignAndLayoutMutation = useMutation({
    mutationFn: async (v: {
      itemId: string;
      assignedTo: string;
      layout: { next_up: string[]; in_design: string[] };
    }) => {
      await api<DesignItem>(`/design-items/${v.itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ assigned_to: v.assignedTo }),
      });
      return api<DesignItem[]>("/design-items/layout", {
        method: "POST",
        body: JSON.stringify(v.layout),
      });
    },
    onSuccess: (list) => {
      qc.setQueryData(["designItems"], list);
      setAssignPrompt(null);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["designItems"] }),
  });

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    dragSnapshotRef.current = qc.getQueryData<DesignItem[]>(["designItems"]) ?? null;
  }

  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || !canWrite) return;
    const cache = qc.getQueryData<DesignItem[]>(["designItems"]);
    if (!cache) return;

    const activeRow = cache.find((f) => f.id === active.id);
    if (!activeRow || (activeRow.status !== "next_up" && activeRow.status !== "in_design")) return;

    const overIdStr = String(over.id);
    let targetStatus: ActiveBucket;
    let overIndex: number;

    const bucket = statusFromBucket(overIdStr);
    if (bucket) {
      targetStatus = bucket;
      const list = cache
        .filter((f) => f.status === targetStatus && f.id !== activeRow.id)
        .sort((a, b) => a.position - b.position);
      overIndex = list.length;
    } else {
      const overRow = cache.find((f) => f.id === overIdStr);
      if (!overRow || overRow.id === activeRow.id) return;
      if (overRow.status !== "next_up" && overRow.status !== "in_design") return;
      targetStatus = overRow.status as ActiveBucket;

      const activeRect = active.rect.current.translated;
      const overRect = over.rect;
      const activeMidY = activeRect ? activeRect.top + activeRect.height / 2 : null;
      const overMidY = overRect ? overRect.top + overRect.height / 2 : null;
      const insertAfter =
        activeMidY != null && overMidY != null && activeMidY > overMidY;

      const list = cache
        .filter((f) => f.status === targetStatus && f.id !== activeRow.id)
        .sort((a, b) => a.position - b.position);
      const idx = list.findIndex((f) => f.id === overRow.id);
      overIndex = idx + (insertAfter ? 1 : 0);
    }

    if (targetStatus === activeRow.status) return;

    const { next_up: nu, in_design: idd } = partitionActive(cache);
    const sourceList = targetStatus === "next_up" ? [...idd] : [...nu];
    const destList =
      targetStatus === "next_up"
        ? nu.filter((f) => f.id !== activeRow.id)
        : idd.filter((f) => f.id !== activeRow.id);
    destList.splice(overIndex, 0, { ...activeRow, status: targetStatus });

    const nextUpIds =
      targetStatus === "next_up" ? destList.map((f) => f.id) : sourceList.map((f) => f.id);
    const inDesignIds =
      targetStatus === "in_design" ? destList.map((f) => f.id) : sourceList.map((f) => f.id);

    qc.setQueryData<DesignItem[]>(
      ["designItems"],
      applyLayout(cache, nextUpIds, inDesignIds),
    );
  }

  function handleDragCancel(_e: DragCancelEvent) {
    if (dragSnapshotRef.current) {
      qc.setQueryData(["designItems"], dragSnapshotRef.current);
    }
    dragSnapshotRef.current = null;
    setActiveId(null);
  }

  function handleDragEnd(e: DragEndEvent) {
    const snapshot = dragSnapshotRef.current;
    dragSnapshotRef.current = null;
    setActiveId(null);

    if (!canWrite) {
      if (snapshot) qc.setQueryData(["designItems"], snapshot);
      return;
    }

    const { active, over } = e;
    if (!over || !snapshot) {
      if (snapshot) qc.setQueryData(["designItems"], snapshot);
      return;
    }

    let cache = qc.getQueryData<DesignItem[]>(["designItems"]);
    if (!cache) {
      qc.setQueryData(["designItems"], snapshot);
      return;
    }

    const activeRow = cache.find((f) => f.id === active.id);
    const overIdStr = String(over.id);
    const overBucket = statusFromBucket(overIdStr);

    if (overBucket && activeRow && activeRow.status !== overBucket) {
      const part = partitionActive(cache);
      let nextUpIds = part.next_up.map((f) => f.id);
      let inDesignIds = part.in_design.map((f) => f.id);
      if (overBucket === "next_up") {
        nextUpIds = [...nextUpIds.filter((id) => id !== activeRow.id), activeRow.id];
        inDesignIds = inDesignIds.filter((id) => id !== activeRow.id);
      } else {
        inDesignIds = [...inDesignIds.filter((id) => id !== activeRow.id), activeRow.id];
        nextUpIds = nextUpIds.filter((id) => id !== activeRow.id);
      }
      cache = applyLayout(cache, nextUpIds, inDesignIds);
      qc.setQueryData(["designItems"], cache);
    }

    if (!overBucket && activeRow && active.id !== over.id) {
      const overRow = cache.find((f) => f.id === overIdStr);
      if (
        overRow &&
        (overRow.status === "next_up" || overRow.status === "in_design") &&
        activeRow.status === overRow.status
      ) {
        const part = partitionActive(cache);
        const list = overRow.status === "next_up" ? part.next_up : part.in_design;
        const ids = list.map((f) => f.id);
        const oldIdx = ids.indexOf(activeRow.id);
        const newIdx = ids.indexOf(overRow.id);
        if (oldIdx >= 0 && newIdx >= 0 && oldIdx !== newIdx) {
          const reordered = arrayMove(ids, oldIdx, newIdx);
          cache =
            overRow.status === "next_up"
              ? applyLayout(cache, reordered, part.in_design.map((f) => f.id))
              : applyLayout(cache, part.next_up.map((f) => f.id), reordered);
          qc.setQueryData(["designItems"], cache);
        }
      }
    }

    const orig = partitionActive(snapshot);
    const curr = partitionActive(cache);
    const nextUpIds = curr.next_up.map((f) => f.id);
    const inDesignIds = curr.in_design.map((f) => f.id);
    const same =
      orig.next_up.map((f) => f.id).join() === nextUpIds.join() &&
      orig.in_design.map((f) => f.id).join() === inDesignIds.join();

    if (same) {
      qc.setQueryData(["designItems"], snapshot);
      return;
    }

    const activeRowId = String(active.id);
    const wasInDesign = orig.in_design.some((f) => f.id === activeRowId);
    const nowInDesign = curr.in_design.some((f) => f.id === activeRowId);
    const movedRow = cache.find((f) => f.id === activeRowId);

    if (movedRow && nowInDesign && !wasInDesign && !movedRow.assigned_to) {
      setAssignPrompt({
        item: movedRow,
        nextUpIds,
        inDesignIds,
        snapshot,
      });
      return;
    }

    layoutMutation.mutate({ next_up: nextUpIds, in_design: inDesignIds });
  }

  function dismissAssignPrompt() {
    if (assignPrompt?.snapshot) {
      qc.setQueryData(["designItems"], assignPrompt.snapshot);
    }
    assignAndLayoutMutation.reset();
    setAssignPrompt(null);
  }

  async function handleComplete(row: DesignItem) {
    if (
      !(await confirm({
        title: `Complete "${row.name}"?`,
        description: "This will move the item to the completed archive.",
        confirmLabel: "Complete",
      }))
    ) {
      return;
    }
    completeMutation.mutate(row.id);
  }

  async function handleDelete(row: DesignItem) {
    if (
      !(await confirm({
        title: `Delete "${row.name}"?`,
        description: "This cannot be undone, but you can view deleted items in the archive below.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    deleteMutation.mutate(row.id);
  }

  if (!items.isFetched) {
    return <div className="p-6 text-sm text-wp-slate">Loading design queue…</div>;
  }

  const teamOptions = teams.data ?? [];
  const userOptions = mentionable.data ?? [];

  const openCreateModal = () => {
    createMutation.reset();
    setName("");
    setDescription("");
    setTeamId("");
    setAssignedTo("");
    setShowCreateModal(true);
  };

  const closeCreateModal = () => {
    createMutation.reset();
    setShowCreateModal(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader
        tabKey="design"
        description="Drag between In Design and Next Up."
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-6">
      <MutationErrorBanner mutation={patchMutation} />
      <MutationErrorBanner mutation={layoutMutation} />
      <MutationErrorBanner mutation={completeMutation} />
      <MutationErrorBanner mutation={deleteMutation} />

      {canWrite ? (
        <button
          type="button"
          className="btn-primary inline-flex items-center gap-2"
          onClick={openCreateModal}
        >
          <Plus size={16} />
          New design item
        </button>
      ) : null}

      {showCreateModal ? (
        <KanbanItemCreateModal
          title="New design item"
          onClose={closeCreateModal}
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
            <div className="min-w-[200px]">
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
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          }
        />
      ) : null}

      {assignPrompt ? (
        <DesignAssignPromptModal
          item={assignPrompt.item}
          userOptions={userOptions}
          onDismiss={dismissAssignPrompt}
          onConfirm={(userId) => {
            const snapshot = assignPrompt.snapshot;
            assignAndLayoutMutation.mutate(
              {
                itemId: assignPrompt.item.id,
                assignedTo: userId,
                layout: {
                  next_up: assignPrompt.nextUpIds,
                  in_design: assignPrompt.inDesignIds,
                },
              },
              {
                onError: () => qc.setQueryData(["designItems"], snapshot),
              },
            );
          }}
          mutation={assignAndLayoutMutation}
        />
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <div className="grid gap-6 md:grid-cols-2">
          <ItemBucket
            title="Next Up"
            status="next_up"
            items={next_up}
            expandedIds={expandedIds}
            canWrite={canWrite}
            teamOptions={teamOptions}
            userOptions={userOptions}
            onToggleExpand={toggleExpanded}
            onComplete={handleComplete}
            onDelete={handleDelete}
            onPatch={(id, body) => patchMutation.mutate({ id, body })}
            patchPending={patchMutation.isPending}
          />
          <ItemBucket
            title="In Design"
            status="in_design"
            items={in_design}
            expandedIds={expandedIds}
            canWrite={canWrite}
            teamOptions={teamOptions}
            userOptions={userOptions}
            onToggleExpand={toggleExpanded}
            onComplete={handleComplete}
            onDelete={handleDelete}
            onPatch={(id, body) => patchMutation.mutate({ id, body })}
            patchPending={patchMutation.isPending}
            showComplete
          />
        </div>
        <DragOverlay>
          {activeItem ? <ItemCardPreview item={activeItem} /> : null}
        </DragOverlay>
      </DndContext>

      <div className="border-t border-wp-stone pt-4">
        <button
          type="button"
          className="btn-ghost text-sm text-wp-slate"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Hide" : "Show"} completed and deleted items
          <ChevronDown
            size={16}
            className={cn("ml-1 inline transition", showArchived ? "rotate-180" : "")}
          />
        </button>
        <Collapsible open={showArchived}>
          <div className="mt-4 space-y-6">
            <ArchivedSection title="Completed" items={completed} timestampField="completed_at" />
            <ArchivedSection title="Deleted" items={deleted} timestampField="deleted_at" />
          </div>
        </Collapsible>
      </div>
        </div>
      </div>
    </div>
  );
}

type UserOption = { id: string; name: string };
type TeamOption = { id: string; name: string };

function ItemBucket({
  title,
  status,
  items,
  expandedIds,
  canWrite,
  teamOptions,
  userOptions,
  onToggleExpand,
  onComplete,
  onDelete,
  onPatch,
  patchPending,
  showComplete = false,
}: {
  title: string;
  status: ActiveBucket;
  items: DesignItem[];
  expandedIds: Set<string>;
  canWrite: boolean;
  teamOptions: TeamOption[];
  userOptions: UserOption[];
  onToggleExpand: (id: string) => void;
  onComplete: (row: DesignItem) => void;
  onDelete: (row: DesignItem) => void;
  onPatch: (
    id: string,
    body: Partial<Pick<DesignItem, "name" | "description" | "team_id" | "assigned_to">>,
  ) => void;
  patchPending: boolean;
  showComplete?: boolean;
}) {
  const droppableId = bucketId(status);

  return (
    <section className="card-surface flex min-h-[280px] flex-col">
      <div className="flex items-center justify-between border-b border-wp-stone px-4 py-3">
        <h2 className="text-sm font-semibold text-wp-ink">{title}</h2>
        <span className="text-xs text-wp-slate">{items.length}</span>
      </div>
      <SortableContext
        items={items.map((f) => f.id)}
        strategy={verticalListSortingStrategy}
        id={droppableId}
      >
        <BucketDroppable id={droppableId}>
          <div className="flex-1 space-y-2 p-3">
            {items.map((row) => (
              <SortableItemRow
                key={row.id}
                item={row}
                expanded={expandedIds.has(row.id)}
                canWrite={canWrite}
                teamOptions={teamOptions}
                userOptions={userOptions}
                showComplete={showComplete}
                onToggleExpand={() => onToggleExpand(row.id)}
                onComplete={() => onComplete(row)}
                onDelete={() => onDelete(row)}
                onPatch={onPatch}
                patchPending={patchPending}
              />
            ))}
            {items.length === 0 ? (
              <div className="rounded border border-dashed border-wp-stone px-2 py-8 text-center text-xs text-wp-slate">
                {canWrite ? "Drop items here" : "No items"}
              </div>
            ) : null}
          </div>
        </BucketDroppable>
      </SortableContext>
    </section>
  );
}

function BucketDroppable({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn("flex flex-1 flex-col rounded-md transition", isOver ? "bg-wp-red/5" : "")}
    >
      {children}
    </div>
  );
}

function SortableItemRow({
  item,
  expanded,
  canWrite,
  teamOptions,
  userOptions,
  showComplete,
  onToggleExpand,
  onComplete,
  onDelete,
  onPatch,
  patchPending,
}: {
  item: DesignItem;
  expanded: boolean;
  canWrite: boolean;
  teamOptions: TeamOption[];
  userOptions: UserOption[];
  showComplete?: boolean;
  onToggleExpand: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onPatch: (
    id: string,
    body: Partial<Pick<DesignItem, "name" | "description" | "team_id" | "assigned_to">>,
  ) => void;
  patchPending: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canWrite,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="rounded-md border border-wp-stone bg-white">
      <ItemRowSummary
        item={item}
        expanded={expanded}
        canWrite={canWrite}
        showComplete={showComplete}
        dragProps={canWrite ? { ...attributes, ...listeners } : undefined}
        onToggleExpand={onToggleExpand}
        onComplete={onComplete}
        onDelete={onDelete}
      />
      <Collapsible open={expanded}>
        <ItemRowDetail
          item={item}
          canWrite={canWrite}
          teamOptions={teamOptions}
          userOptions={userOptions}
          onPatch={onPatch}
          patchPending={patchPending}
        />
      </Collapsible>
    </div>
  );
}

function ItemCardPreview({ item }: { item: DesignItem }) {
  return (
    <div className="rounded-md border border-wp-stone bg-white p-3 shadow-lg">
      <ItemRowSummary
        item={item}
        expanded={false}
        canWrite={false}
        onToggleExpand={() => {}}
        onComplete={() => {}}
        onDelete={() => {}}
      />
    </div>
  );
}

function designItemSourceKind(item: DesignItem): "simple_feature" | "design_tab" | "roadmap" {
  if (item.simple_feature_id) return "simple_feature";
  if (item.project_id) return "roadmap";
  if (item.source === "Design Tab") return "design_tab";
  if (item.source === "Simple Feature") return "simple_feature";
  return "roadmap";
}

function designItemSourceName(
  item: DesignItem,
  kind: ReturnType<typeof designItemSourceKind>,
): string {
  const trimmed = item.source?.trim();
  if (trimmed) return trimmed;
  switch (kind) {
    case "simple_feature":
      return "Simple Feature";
    case "design_tab":
      return "Design Tab";
    case "roadmap":
      return "Roadmap";
  }
}

function DesignItemSourceIcon({ item }: { item: DesignItem }) {
  const kind = designItemSourceKind(item);
  const sourceName = designItemSourceName(item, kind);
  const Icon = kind === "simple_feature" ? Zap : kind === "design_tab" ? Paintbrush : MapIcon;
  return (
    <InfoTooltip content={sourceName} side="top" align="center">
      <span
        className="inline-flex cursor-default text-wp-slate"
        aria-label={`Source: ${sourceName}`}
      >
        <Icon size={14} className="shrink-0" />
      </span>
    </InfoTooltip>
  );
}

function ItemRowSummary({
  item,
  expanded,
  canWrite,
  showComplete,
  dragProps,
  onToggleExpand,
  onComplete,
  onDelete,
}: {
  item: DesignItem;
  expanded: boolean;
  canWrite: boolean;
  showComplete?: boolean;
  dragProps?: Record<string, unknown>;
  onToggleExpand: () => void;
  onComplete: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${item.name}`}
      onClick={onToggleExpand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleExpand();
        }
      }}
      className="flex cursor-pointer items-start gap-2 p-3 hover:bg-wp-stone/20"
    >
      {dragProps ? (
        <button
          type="button"
          className="mt-0.5 shrink-0 cursor-grab touch-none select-none rounded p-0.5 text-wp-slate hover:bg-wp-stone/50 hover:text-wp-ink active:cursor-grabbing"
          aria-label={`Drag ${item.name}`}
          title="Drag to reorder"
          {...dragProps}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <GripVertical size={14} />
        </button>
      ) : null}
      <span className="mt-0.5 shrink-0 text-wp-slate" aria-hidden="true">
        <ChevronDown size={16} className={cn("transition", expanded ? "rotate-180" : "")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-wp-ink">{item.name}</span>
          <DesignItemSourceIcon item={item} />
          {item.team_name ? (
            <span
              className="chip text-xs"
              style={
                item.team_color
                  ? { borderColor: item.team_color, color: item.team_color }
                  : undefined
              }
            >
              {item.team_name}
            </span>
          ) : null}
          {item.status === "in_design" || item.assignee_name ? (
            <span
              className={cn(
                "chip inline-flex items-center gap-1 text-xs",
                item.assignee_name ? "text-wp-ink" : "border-dashed text-wp-slate",
              )}
              title={item.assignee_name ? `Assigned to ${item.assignee_name}` : "Unassigned"}
            >
              <User size={11} className="shrink-0" />
              {item.assignee_name ?? "Unassigned"}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canWrite && showComplete ? (
          <button
            type="button"
            className="btn-ghost !p-1.5 text-emerald-700 hover:text-emerald-900"
            title="Complete"
            aria-label="Complete"
            onClick={(e) => {
              e.stopPropagation();
              onComplete();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Check size={16} />
          </button>
        ) : null}
        {canWrite ? (
          <button
            type="button"
            className="btn-ghost !p-1.5 text-wp-slate hover:text-wp-red"
            title="Delete"
            aria-label="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Trash2 size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ItemRowDetail({
  item,
  canWrite,
  teamOptions,
  userOptions,
  onPatch,
  patchPending,
}: {
  item: DesignItem;
  canWrite: boolean;
  teamOptions: TeamOption[];
  userOptions: UserOption[];
  onPatch: (
    id: string,
    body: Partial<Pick<DesignItem, "name" | "description" | "team_id" | "assigned_to">>,
  ) => void;
  patchPending: boolean;
}) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [teamId, setTeamId] = useState(item.team_id ?? "");
  const [assignedTo, setAssignedTo] = useState(item.assigned_to ?? "");

  const descriptionText = item.description?.trim() ?? "";

  if (canWrite) {
    return (
      <form
        className="space-y-3 border-t border-wp-stone px-3 pb-3 pt-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          onPatch(item.id, {
            name: name.trim(),
            description: description.trim(),
            team_id: teamId || null,
            assigned_to: assignedTo || null,
          });
        }}
      >
        <div>
          <label className="text-xs font-medium text-wp-slate">Name</label>
          <input
            className="input mt-1 w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={256}
            required
          />
        </div>
        <div>
          <label className="text-xs font-medium text-wp-slate">Description</label>
          <textarea
            className="input mt-1 w-full min-h-[80px]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-wp-slate">Product area</label>
            <select
              className="input mt-1 w-full"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">— None —</option>
              {teamOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-wp-slate">Assigned to</label>
            <select
              className="input mt-1 w-full"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <option value="">— Unassigned —</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <span className="font-medium text-wp-slate">Creator</span>
            <p className="mt-0.5">{item.creator_name}</p>
          </div>
          <div>
            <span className="font-medium text-wp-slate">Created</span>
            <p className="mt-0.5">{formatTimestamp(item.created_at)}</p>
          </div>
          <div>
            <span className="font-medium text-wp-slate">Source</span>
            <p className="mt-0.5">{item.source || "—"}</p>
          </div>
          {item.project_id ? (
            <div>
              <span className="font-medium text-wp-slate">Roadmap item</span>
              <p className="mt-0.5">
                <a href={`/projects/${item.project_id}`} className="text-wp-red hover:underline">
                  View project
                </a>
              </p>
            </div>
          ) : null}
        </div>
        <button type="submit" className="btn-primary" disabled={!name.trim() || patchPending}>
          {patchPending ? "Saving…" : "Save changes"}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-2 border-t border-wp-stone px-3 pb-3 pt-2 text-sm text-wp-ink/85">
      <div>
        <span className="text-xs font-medium text-wp-slate">Description</span>
        <p className={cn("mt-0.5 whitespace-pre-line", !descriptionText && "italic text-wp-slate")}>
          {descriptionText || "No description"}
        </p>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <span className="font-medium text-wp-slate">Creator</span>
          <p>{item.creator_name}</p>
        </div>
        <div>
          <span className="font-medium text-wp-slate">Created</span>
          <p>{formatTimestamp(item.created_at)}</p>
        </div>
        <div>
          <span className="font-medium text-wp-slate">Product area</span>
          <p>{item.team_name ?? "—"}</p>
        </div>
        <div>
          <span className="font-medium text-wp-slate">Assigned to</span>
          <p>{item.assignee_name ?? "—"}</p>
        </div>
        <div>
          <span className="font-medium text-wp-slate">Source</span>
          <p>{item.source || "—"}</p>
        </div>
      </div>
    </div>
  );
}

function ArchivedSection({
  title,
  items,
  timestampField,
}: {
  title: string;
  items: DesignItem[];
  timestampField: "completed_at" | "deleted_at";
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-wp-ink">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm italic text-wp-slate">None</p>
      ) : (
        <ul className="mt-2 divide-y divide-wp-stone rounded-md border border-wp-stone">
          {items.map((row) => {
            const ts = row[timestampField];
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <span className="font-medium text-wp-ink">{row.name}</span>
                {row.team_name ? <span className="text-xs text-wp-slate">{row.team_name}</span> : null}
                <span className="text-xs text-wp-slate">{row.creator_name}</span>
                {row.assignee_name ? (
                  <span className="text-xs text-wp-slate">→ {row.assignee_name}</span>
                ) : null}
                {ts ? <span className="text-xs text-wp-slate">{formatTimestamp(ts)}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
