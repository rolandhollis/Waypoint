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
import {
  Check,
  ChevronDown,
  GripVertical,
  Paintbrush,
  Plus,
  Trash2,
} from "lucide-react";
import { Collapsible } from "../components/Collapsible";
import { KanbanItemCreateModal } from "../components/KanbanItemCreateModal";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { useAppDialog } from "../components/AppDialogProvider";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useCanWrite, useSimpleFeatures, useTeams } from "../lib/queries";
import type { SimpleFeature } from "../lib/types";

const BUCKET_NEXT = "bucket:next_up";
const BUCKET_DEV = "bucket:in_development";

type ActiveBucket = "next_up" | "in_development";

function bucketId(status: ActiveBucket): string {
  return status === "next_up" ? BUCKET_NEXT : BUCKET_DEV;
}

function statusFromBucket(id: string): ActiveBucket | null {
  if (id === BUCKET_NEXT) return "next_up";
  if (id === BUCKET_DEV) return "in_development";
  return null;
}

function partitionActive(items: SimpleFeature[]) {
  const next_up = items
    .filter((f) => f.status === "next_up")
    .sort((a, b) => a.position - b.position);
  const in_development = items
    .filter((f) => f.status === "in_development")
    .sort((a, b) => a.position - b.position);
  return { next_up, in_development };
}

function applyLayout(
  items: SimpleFeature[],
  nextUpIds: string[],
  inDevIds: string[],
): SimpleFeature[] {
  const byId = new Map(items.map((f) => [f.id, f]));
  const next = [...items];
  for (let i = 0; i < nextUpIds.length; i++) {
    const id = nextUpIds[i];
    if (!id) continue;
    const row = byId.get(id);
    if (!row) continue;
    const idx = next.findIndex((f) => f.id === row.id);
    if (idx >= 0) {
      next[idx] = { ...row, status: "next_up", position: i };
    }
  }
  for (let i = 0; i < inDevIds.length; i++) {
    const id = inDevIds[i];
    if (!id) continue;
    const row = byId.get(id);
    if (!row) continue;
    const idx = next.findIndex((f) => f.id === row.id);
    if (idx >= 0) {
      next[idx] = { ...row, status: "in_development", position: i };
    }
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
 * Lightweight tracker for small initiatives (&lt;16h) that never land on
 * the roadmap. Two drag-reorderable active lists plus hidden archives.
 */
export function SimpleFeaturesView() {
  const features = useSimpleFeatures();
  const teams = useTeams();
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const { confirm } = useAppDialog();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragSnapshotRef = useRef<SimpleFeature[] | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teamId, setTeamId] = useState<string>("");
  const [needsDesign, setNeedsDesign] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const all = features.data ?? [];
  const { next_up, in_development } = partitionActive(all);
  const completed = all
    .filter((f) => f.status === "completed")
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  const deleted = all
    .filter((f) => f.status === "deleted")
    .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? ""));

  const activeFeature = activeId ? all.find((f) => f.id === activeId) : null;

  const createMutation = useMutation({
    mutationFn: () =>
      api<SimpleFeature>("/simple-features", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          team_id: teamId || null,
          needs_design: needsDesign,
        }),
      }),
    onSuccess: (row) => {
      setName("");
      setDescription("");
      setTeamId("");
      setNeedsDesign(false);
      setShowCreateModal(false);
      qc.setQueryData<SimpleFeature[]>(["simpleFeatures"], (prev) =>
        prev ? [row, ...prev.filter((f) => f.id !== row.id)] : [row],
      );
    },
  });

  const layoutMutation = useMutation({
    mutationFn: (body: { next_up: string[]; in_development: string[] }) =>
      api<SimpleFeature[]>("/simple-features/layout", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onError: () => {
      if (dragSnapshotRef.current) {
        qc.setQueryData(["simpleFeatures"], dragSnapshotRef.current);
      }
    },
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) =>
      api<SimpleFeature>(`/simple-features/${id}/complete`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["simpleFeatures"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/simple-features/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["simpleFeatures"] }),
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
    dragSnapshotRef.current = qc.getQueryData<SimpleFeature[]>(["simpleFeatures"]) ?? null;
  }

  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || !canWrite) return;
    const cache = qc.getQueryData<SimpleFeature[]>(["simpleFeatures"]);
    if (!cache) return;

    const activeRow = cache.find((f) => f.id === active.id);
    if (!activeRow || activeRow.status !== "next_up" && activeRow.status !== "in_development") return;

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
      if (overRow.status !== "next_up" && overRow.status !== "in_development") return;
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

    const { next_up: nu, in_development: idv } = partitionActive(cache);
    const sourceList = targetStatus === "next_up" ? [...idv] : [...nu];
    const destList =
      targetStatus === "next_up"
        ? nu.filter((f) => f.id !== activeRow.id)
        : idv.filter((f) => f.id !== activeRow.id);
    destList.splice(overIndex, 0, { ...activeRow, status: targetStatus });

    const nextUpIds =
      targetStatus === "next_up" ? destList.map((f) => f.id) : sourceList.map((f) => f.id);
    const inDevIds =
      targetStatus === "in_development" ? destList.map((f) => f.id) : sourceList.map((f) => f.id);

    qc.setQueryData<SimpleFeature[]>(
      ["simpleFeatures"],
      applyLayout(cache, nextUpIds, inDevIds),
    );
  }

  function handleDragCancel(_e: DragCancelEvent) {
    if (dragSnapshotRef.current) {
      qc.setQueryData(["simpleFeatures"], dragSnapshotRef.current);
    }
    dragSnapshotRef.current = null;
    setActiveId(null);
  }

  function handleDragEnd(e: DragEndEvent) {
    const snapshot = dragSnapshotRef.current;
    dragSnapshotRef.current = null;
    setActiveId(null);

    if (!canWrite) {
      if (snapshot) qc.setQueryData(["simpleFeatures"], snapshot);
      return;
    }

    const { active, over } = e;
    if (!over || !snapshot) {
      if (snapshot) qc.setQueryData(["simpleFeatures"], snapshot);
      return;
    }

    let cache = qc.getQueryData<SimpleFeature[]>(["simpleFeatures"]);
    if (!cache) {
      qc.setQueryData(["simpleFeatures"], snapshot);
      return;
    }

    const activeRow = cache.find((f) => f.id === active.id);
    const overIdStr = String(over.id);
    const overBucket = statusFromBucket(overIdStr);

    // Cross-lane drop on an empty bucket (dragOver may not have fired).
    if (overBucket && activeRow && activeRow.status !== overBucket) {
      const part = partitionActive(cache);
      let nextUpIds = part.next_up.map((f) => f.id);
      let inDevIds = part.in_development.map((f) => f.id);
      if (overBucket === "next_up") {
        nextUpIds = [...nextUpIds.filter((id) => id !== activeRow.id), activeRow.id];
        inDevIds = inDevIds.filter((id) => id !== activeRow.id);
      } else {
        inDevIds = [...inDevIds.filter((id) => id !== activeRow.id), activeRow.id];
        nextUpIds = nextUpIds.filter((id) => id !== activeRow.id);
      }
      cache = applyLayout(cache, nextUpIds, inDevIds);
      qc.setQueryData(["simpleFeatures"], cache);
    }

    // Same-list reorder: dragOver intentionally skips same lane, so apply here.
    if (!overBucket && activeRow && active.id !== over.id) {
      const overRow = cache.find((f) => f.id === overIdStr);
      if (
        overRow &&
        (overRow.status === "next_up" || overRow.status === "in_development") &&
        activeRow.status === overRow.status
      ) {
        const part = partitionActive(cache);
        const list =
          overRow.status === "next_up" ? part.next_up : part.in_development;
        const ids = list.map((f) => f.id);
        const oldIdx = ids.indexOf(activeRow.id);
        const newIdx = ids.indexOf(overRow.id);
        if (oldIdx >= 0 && newIdx >= 0 && oldIdx !== newIdx) {
          const reordered = arrayMove(ids, oldIdx, newIdx);
          cache =
            overRow.status === "next_up"
              ? applyLayout(cache, reordered, part.in_development.map((f) => f.id))
              : applyLayout(cache, part.next_up.map((f) => f.id), reordered);
          qc.setQueryData(["simpleFeatures"], cache);
        }
      }
    }

    const orig = partitionActive(snapshot);
    const curr = partitionActive(cache);
    const nextUpIds = curr.next_up.map((f) => f.id);
    const inDevIds = curr.in_development.map((f) => f.id);
    const same =
      orig.next_up.map((f) => f.id).join() === nextUpIds.join() &&
      orig.in_development.map((f) => f.id).join() === inDevIds.join();

    if (same) {
      qc.setQueryData(["simpleFeatures"], snapshot);
      return;
    }

    layoutMutation.mutate({ next_up: nextUpIds, in_development: inDevIds });
  }

  async function handleComplete(row: SimpleFeature) {
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

  async function handleDelete(row: SimpleFeature) {
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

  if (!features.isFetched) {
    return <div className="p-6 text-sm text-wp-slate">Loading simple features…</div>;
  }

  const teamOptions = teams.data ?? [];

  const openCreateModal = () => {
    createMutation.reset();
    setName("");
    setDescription("");
    setTeamId("");
    setNeedsDesign(false);
    setShowCreateModal(true);
  };

  const closeCreateModal = () => {
    createMutation.reset();
    setShowCreateModal(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader
        tabKey="simple_features"
        description="Drag items between Next Up and In Development."
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-6">
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
          New simple feature
        </button>
      ) : null}

      {showCreateModal ? (
        <KanbanItemCreateModal
          title="New simple feature"
          onClose={closeCreateModal}
          name={name}
          onNameChange={setName}
          description={description}
          onDescriptionChange={setDescription}
          teamId={teamId}
          onTeamIdChange={setTeamId}
          teamOptions={teamOptions}
          nameFieldId="sf-name"
          descriptionFieldId="sf-desc"
          mutation={createMutation}
          canSubmit={name.trim().length > 0}
          onSubmit={() => createMutation.mutate()}
          extraFields={
            <label className="flex items-center gap-2 self-end text-sm text-wp-ink">
              <input
                type="checkbox"
                checked={needsDesign}
                onChange={(e) => setNeedsDesign(e.target.checked)}
              />
              Needs design
            </label>
          }
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
          <FeatureBucket
            title="Next Up"
            status="next_up"
            items={next_up}
            expandedIds={expandedIds}
            canWrite={canWrite}
            onToggleExpand={toggleExpanded}
            onComplete={handleComplete}
            onDelete={handleDelete}
          />
          <FeatureBucket
            title="In Development"
            status="in_development"
            items={in_development}
            expandedIds={expandedIds}
            canWrite={canWrite}
            onToggleExpand={toggleExpanded}
            onComplete={handleComplete}
            onDelete={handleDelete}
            showComplete
          />
        </div>
        <DragOverlay>
          {activeFeature ? (
            <FeatureCardPreview feature={activeFeature} />
          ) : null}
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

function FeatureBucket({
  title,
  status,
  items,
  expandedIds,
  canWrite,
  onToggleExpand,
  onComplete,
  onDelete,
  showComplete = false,
}: {
  title: string;
  status: ActiveBucket;
  items: SimpleFeature[];
  expandedIds: Set<string>;
  canWrite: boolean;
  onToggleExpand: (id: string) => void;
  onComplete: (row: SimpleFeature) => void;
  onDelete: (row: SimpleFeature) => void;
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
              <SortableFeatureRow
                key={row.id}
                feature={row}
                expanded={expandedIds.has(row.id)}
                canWrite={canWrite}
                showComplete={showComplete}
                onToggleExpand={() => onToggleExpand(row.id)}
                onComplete={() => onComplete(row)}
                onDelete={() => onDelete(row)}
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

function SortableFeatureRow({
  feature,
  expanded,
  canWrite,
  showComplete,
  onToggleExpand,
  onComplete,
  onDelete,
}: {
  feature: SimpleFeature;
  expanded: boolean;
  canWrite: boolean;
  showComplete?: boolean;
  onToggleExpand: () => void;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: feature.id,
    disabled: !canWrite,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="rounded-md border border-wp-stone bg-white">
      <FeatureRowSummary
        feature={feature}
        expanded={expanded}
        canWrite={canWrite}
        showComplete={showComplete}
        dragProps={canWrite ? { ...attributes, ...listeners } : undefined}
        onToggleExpand={onToggleExpand}
        onComplete={onComplete}
        onDelete={onDelete}
      />
      <Collapsible open={expanded}>
        <FeatureRowDetail feature={feature} />
      </Collapsible>
    </div>
  );
}

function FeatureCardPreview({ feature }: { feature: SimpleFeature }) {
  return (
    <div className="rounded-md border border-wp-stone bg-white p-3 shadow-lg">
      <FeatureRowSummary
        feature={feature}
        expanded={false}
        canWrite={false}
        onToggleExpand={() => {}}
        onComplete={() => {}}
        onDelete={() => {}}
      />
    </div>
  );
}

function FeatureRowSummary({
  feature,
  expanded,
  canWrite,
  showComplete,
  dragProps,
  onToggleExpand,
  onComplete,
  onDelete,
}: {
  feature: SimpleFeature;
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
      className={cn(
        "flex items-start gap-2 p-3",
        dragProps && "cursor-grab touch-none select-none active:cursor-grabbing",
      )}
      {...dragProps}
    >
      {dragProps ? (
        <span className="mt-0.5 shrink-0 text-wp-slate pointer-events-none" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      ) : null}
      <button
        type="button"
        className="mt-0.5 shrink-0 text-wp-slate hover:text-wp-ink"
        onClick={onToggleExpand}
        onPointerDown={(e) => e.stopPropagation()}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse details" : "Expand details"}
      >
        <ChevronDown size={16} className={cn("transition", expanded ? "rotate-180" : "")} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-wp-ink">{feature.name}</span>
          {feature.team_name ? (
            <span
              className="chip text-xs"
              style={
                feature.team_color
                  ? { borderColor: feature.team_color, color: feature.team_color }
                  : undefined
              }
            >
              {feature.team_name}
            </span>
          ) : null}
          {feature.needs_design ? (
            <span
              className="text-wp-slate"
              title="Needs design"
              aria-label="Needs design"
            >
              <Paintbrush size={14} />
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-wp-slate">{feature.creator_name}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canWrite && showComplete ? (
          <button
            type="button"
            className="btn-ghost !p-1.5 text-emerald-700 hover:text-emerald-900"
            title="Complete"
            aria-label="Complete"
            onClick={onComplete}
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
            onClick={onDelete}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Trash2 size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FeatureRowDetail({ feature }: { feature: SimpleFeature }) {
  const description = feature.description?.trim() ?? "";
  return (
    <div className="space-y-2 border-t border-wp-stone px-3 pb-3 pt-2 text-sm text-wp-ink/85">
      <div>
        <span className="text-xs font-medium text-wp-slate">Description</span>
        <p className={cn("mt-0.5 whitespace-pre-line", !description && "italic text-wp-slate")}>
          {description || "No description"}
        </p>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <span className="font-medium text-wp-slate">Creator</span>
          <p>{feature.creator_name}</p>
        </div>
        <div>
          <span className="font-medium text-wp-slate">Created</span>
          <p>{formatTimestamp(feature.created_at)}</p>
        </div>
        <div>
          <span className="font-medium text-wp-slate">Product area</span>
          <p>{feature.team_name ?? "—"}</p>
        </div>
        <div>
          <span className="font-medium text-wp-slate">Needs design</span>
          <p>{feature.needs_design ? "Yes" : "No"}</p>
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
  items: SimpleFeature[];
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
                {row.team_name ? (
                  <span className="text-xs text-wp-slate">{row.team_name}</span>
                ) : null}
                <span className="text-xs text-wp-slate">{row.creator_name}</span>
                {ts ? (
                  <span className="text-xs text-wp-slate">{formatTimestamp(ts)}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
