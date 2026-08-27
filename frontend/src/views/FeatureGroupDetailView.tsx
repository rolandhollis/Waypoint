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
import { ChevronDown, GripVertical, Plus, Trash2 } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Collapsible } from "../components/Collapsible";
import { NameDescriptionModal } from "../components/NameDescriptionModal";
import { FeatureGroupCsvImport } from "../components/FeatureGroupCsvImport";
import { useAppDialog } from "../components/AppDialogProvider";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  PRIORITY_TIERS,
  applyFeatureLayout,
  bucketId,
  partitionByTier,
  tierFromBucket,
  type FeatureLayout,
  type PriorityTier,
} from "../lib/featureGroupLayout";
import { useCanWrite, useFeatureGroup } from "../lib/queries";
import type { FeatureGroupFeature, FeatureGroupSummary } from "../lib/types";

const TIER_LABELS: Record<PriorityTier, string> = {
  P0: "P0 — Must have",
  P1: "P1 — Should have",
  P2: "P2 — Nice to have",
  P3: "P3 — Future consideration",
};

function featuresByTier(features: FeatureGroupFeature[], tier: PriorityTier): FeatureGroupFeature[] {
  return features
    .filter((f) => f.priority_tier === tier)
    .sort((a, b) => a.position - b.position);
}

export function FeatureGroupDetailView() {
  const { groupId } = useParams<{ groupId: string }>();
  const detail = useFeatureGroup(groupId);
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  const { confirm } = useAppDialog();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragSnapshotRef = useRef<FeatureGroupSummary | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const group = detail.data;
  const features = group?.features ?? [];
  const activeFeature = activeId ? features.find((f) => f.id === activeId) : null;

  const createMutation = useMutation({
    mutationFn: () =>
      api<FeatureGroupFeature>(`/feature-groups/${groupId}/features`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      }),
    onSuccess: (row) => {
      setName("");
      setDescription("");
      setShowCreateModal(false);
      qc.setQueryData<FeatureGroupSummary>(["featureGroups", groupId], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          feature_count: prev.feature_count + 1,
          features: [...(prev.features ?? []).filter((f) => f.id !== row.id), row],
        };
      });
      qc.invalidateQueries({ queryKey: ["featureGroups"] });
    },
  });

  const layoutMutation = useMutation({
    mutationFn: (layout: FeatureLayout) =>
      api<FeatureGroupSummary>(`/feature-groups/${groupId}/features/layout`, {
        method: "POST",
        body: JSON.stringify(layout),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(["featureGroups", groupId], updated);
    },
    onError: () => {
      if (dragSnapshotRef.current) {
        qc.setQueryData(["featureGroups", groupId], dragSnapshotRef.current);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (featureId: string) =>
      api(`/feature-groups/${groupId}/features/${featureId}`, { method: "DELETE" }),
    onSuccess: (_data, featureId) => {
      qc.setQueryData<FeatureGroupSummary>(["featureGroups", groupId], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          feature_count: Math.max(0, prev.feature_count - 1),
          features: (prev.features ?? []).filter((f) => f.id !== featureId),
        };
      });
      qc.invalidateQueries({ queryKey: ["featureGroups"] });
    },
  });

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function handleDeleteFeature(feature: FeatureGroupFeature) {
    if (
      !(await confirm({
        title: `Delete "${feature.name}"?`,
        description: "This removes the feature from the group.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    deleteMutation.mutate(feature.id);
  }

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    dragSnapshotRef.current = qc.getQueryData<FeatureGroupSummary>(["featureGroups", groupId]) ?? null;
  }

  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || !canWrite || !groupId) return;
    const cache = qc.getQueryData<FeatureGroupSummary>(["featureGroups", groupId]);
    if (!cache?.features) return;

    const activeRow = cache.features.find((f) => f.id === active.id);
    if (!activeRow) return;

    const overIdStr = String(over.id);
    const overTier = tierFromBucket(overIdStr);
    let targetTier: PriorityTier;
    let overIndex: number;

    if (overTier) {
      targetTier = overTier;
      const list = cache.features
        .filter((f) => f.priority_tier === targetTier && f.id !== activeRow.id)
        .sort((a, b) => a.position - b.position);
      overIndex = list.length;
    } else {
      const overRow = cache.features.find((f) => f.id === overIdStr);
      if (!overRow || overRow.id === activeRow.id) return;
      targetTier = overRow.priority_tier;

      const activeRect = active.rect.current.translated;
      const overRect = over.rect;
      const activeMidY = activeRect ? activeRect.top + activeRect.height / 2 : null;
      const overMidY = overRect ? overRect.top + overRect.height / 2 : null;
      const insertAfter = activeMidY != null && overMidY != null && activeMidY > overMidY;

      const list = cache.features
        .filter((f) => f.priority_tier === targetTier && f.id !== activeRow.id)
        .sort((a, b) => a.position - b.position);
      const idx = list.findIndex((f) => f.id === overRow.id);
      overIndex = idx + (insertAfter ? 1 : 0);
    }

    if (targetTier === activeRow.priority_tier) return;

    const layout = partitionByTier(cache.features);
    const sourceTier = activeRow.priority_tier;
    const sourceList = layout[sourceTier].filter((id) => id !== activeRow.id);
    const destList = layout[targetTier].filter((id) => id !== activeRow.id);
    destList.splice(overIndex, 0, activeRow.id);
    layout[sourceTier] = sourceTier === targetTier ? destList : sourceList;
    layout[targetTier] = destList;

    qc.setQueryData<FeatureGroupSummary>(["featureGroups", groupId], {
      ...cache,
      features: applyFeatureLayout(cache.features, layout),
    });
  }

  function handleDragCancel(_e: DragCancelEvent) {
    if (dragSnapshotRef.current) {
      qc.setQueryData(["featureGroups", groupId], dragSnapshotRef.current);
    }
    dragSnapshotRef.current = null;
    setActiveId(null);
  }

  function handleDragEnd(e: DragEndEvent) {
    const snapshot = dragSnapshotRef.current;
    dragSnapshotRef.current = null;
    setActiveId(null);

    if (!canWrite || !groupId) {
      if (snapshot) qc.setQueryData(["featureGroups", groupId], snapshot);
      return;
    }

    const { active, over } = e;
    if (!over || !snapshot?.features) {
      if (snapshot) qc.setQueryData(["featureGroups", groupId], snapshot);
      return;
    }

    let cache = qc.getQueryData<FeatureGroupSummary>(["featureGroups", groupId]);
    if (!cache?.features) {
      if (snapshot) qc.setQueryData(["featureGroups", groupId], snapshot);
      return;
    }
    const cacheFeatures = cache.features;

    const activeRow = cacheFeatures.find((f) => f.id === active.id);
    const overIdStr = String(over.id);
    const overTier = tierFromBucket(overIdStr);

    if (overTier && activeRow && activeRow.priority_tier !== overTier) {
      const layout = partitionByTier(cacheFeatures);
      layout[activeRow.priority_tier] = layout[activeRow.priority_tier].filter(
        (id) => id !== activeRow.id,
      );
      layout[overTier] = [...layout[overTier].filter((id) => id !== activeRow.id), activeRow.id];
      cache = { ...cache, features: applyFeatureLayout(cacheFeatures, layout) };
      qc.setQueryData(["featureGroups", groupId], cache);
    }

    if (!overTier && activeRow && active.id !== over.id) {
      const overRow = cacheFeatures.find((f) => f.id === overIdStr);
      if (overRow && activeRow.priority_tier === overRow.priority_tier) {
        const layout = partitionByTier(cacheFeatures);
        const ids = layout[overRow.priority_tier];
        const oldIdx = ids.indexOf(activeRow.id);
        const newIdx = ids.indexOf(overRow.id);
        if (oldIdx >= 0 && newIdx >= 0 && oldIdx !== newIdx) {
          layout[overRow.priority_tier] = arrayMove(ids, oldIdx, newIdx);
          cache = { ...cache, features: applyFeatureLayout(cacheFeatures, layout) };
          qc.setQueryData(["featureGroups", groupId], cache);
        }
      }
    }

    const origLayout = partitionByTier(snapshot.features ?? []);
    const currLayout = partitionByTier(cache.features ?? []);
    const same = PRIORITY_TIERS.every(
      (tier) => origLayout[tier].join() === currLayout[tier].join(),
    );

    if (same) {
      qc.setQueryData(["featureGroups", groupId], snapshot);
      return;
    }

    layoutMutation.mutate(currLayout);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b border-wp-stone bg-white px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-wp-red">Queues</p>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link to="/feature-groups" className="text-sm text-wp-slate hover:text-wp-red hover:underline">
            Feature Groups
          </Link>
          <span className="text-sm text-wp-slate/50">/</span>
          <h1 className="text-xl font-semibold text-wp-ink">
            {group?.name ?? (detail.isLoading ? "Loading…" : "Group not found")}
          </h1>
        </div>
        {group?.description ? (
          <p className="mt-1 text-sm text-wp-slate">{group.description}</p>
        ) : null}
        <p className="mt-1 text-sm text-wp-slate">
          Drag features between priority tiers to assign P0–P3. Overall rank follows tier order, then
          position within each tier.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          {canWrite ? (
            <div className="flex flex-wrap items-start justify-end gap-3">
              <FeatureGroupCsvImport groupId={groupId!} disabled={!group} />
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowCreateModal(true)}
                disabled={!group}
              >
                <Plus size={16} className="mr-1 inline" />
                Add feature
              </button>
            </div>
          ) : null}

          {detail.isError ? (
            <p className="text-sm text-wp-red">Couldn&apos;t load this feature group.</p>
          ) : detail.isLoading ? (
            <p className="text-sm text-wp-slate">Loading…</p>
          ) : !group ? (
            <p className="text-sm text-wp-slate">
              Group not found.{" "}
              <Link to="/feature-groups" className="text-wp-red hover:underline">
                Back to list
              </Link>
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragCancel={handleDragCancel}
              onDragEnd={handleDragEnd}
            >
              <div className="space-y-4">
                {PRIORITY_TIERS.map((tier) => (
                  <TierSection
                    key={tier}
                    tier={tier}
                    features={featuresByTier(features, tier)}
                    canWrite={canWrite}
                    expandedIds={expandedIds}
                    onToggleExpand={toggleExpanded}
                    onDelete={handleDeleteFeature}
                  />
                ))}
              </div>
              <DragOverlay>
                {activeFeature ? <FeatureCardPreview feature={activeFeature} /> : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      {showCreateModal ? (
        <NameDescriptionModal
          title="New feature"
          nameFieldId="feature-name"
          descriptionFieldId="feature-desc"
          name={name}
          onNameChange={setName}
          description={description}
          onDescriptionChange={setDescription}
          onClose={() => setShowCreateModal(false)}
          canSubmit={name.trim().length > 0}
          onSubmit={() => createMutation.mutate()}
          mutation={createMutation}
          submitLabel="Add feature"
        />
      ) : null}
    </div>
  );
}

function TierSection({
  tier,
  features,
  canWrite,
  expandedIds,
  onToggleExpand,
  onDelete,
}: {
  tier: PriorityTier;
  features: FeatureGroupFeature[];
  canWrite: boolean;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  onDelete: (feature: FeatureGroupFeature) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: bucketId(tier) });

  return (
    <section className="rounded-md border border-wp-stone bg-white">
      <div className="border-b border-wp-stone bg-wp-stone/30 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
          {TIER_LABELS[tier]}
        </h2>
        <p className="text-[11px] text-wp-slate/70">
          {features.length} feature{features.length === 1 ? "" : "s"}
        </p>
      </div>
      <div
        ref={setNodeRef}
        className={cn("min-h-[3rem] p-2 transition", isOver && "bg-wp-red/5")}
      >
        <SortableContext items={features.map((f) => f.id)} strategy={verticalListSortingStrategy}>
          {features.length === 0 ? (
            <p className="px-2 py-3 text-xs italic text-wp-slate/60">
              {canWrite ? "Drop features here" : "No features in this tier"}
            </p>
          ) : (
            <ul className="space-y-2">
              {features.map((feature) => (
                <SortableFeatureRow
                  key={feature.id}
                  feature={feature}
                  expanded={expandedIds.has(feature.id)}
                  canWrite={canWrite}
                  onToggleExpand={() => onToggleExpand(feature.id)}
                  onDelete={() => void onDelete(feature)}
                />
              ))}
            </ul>
          )}
        </SortableContext>
      </div>
    </section>
  );
}

function SortableFeatureRow({
  feature,
  expanded,
  canWrite,
  onToggleExpand,
  onDelete,
}: {
  feature: FeatureGroupFeature;
  expanded: boolean;
  canWrite: boolean;
  onToggleExpand: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: feature.id,
    disabled: !canWrite,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-md border border-wp-stone bg-white",
        isDragging && "z-10 opacity-90 shadow-md",
      )}
    >
      <div className="flex items-start gap-2 px-2 py-2">
        {canWrite ? (
          <button
            type="button"
            className="btn-ghost mt-0.5 !cursor-grab !p-1 text-wp-slate active:!cursor-grabbing"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={16} />
          </button>
        ) : (
          <span className="w-7" />
        )}
        <button
          type="button"
          className="mt-0.5 shrink-0 text-wp-slate"
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          <ChevronDown size={16} className={cn("transition", expanded ? "rotate-180" : "")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-semibold tabular-nums text-wp-slate">
              #{feature.rank + 1}
            </span>
            <span className="font-medium text-wp-ink">{feature.name}</span>
          </div>
          {!expanded && feature.description ? (
            <p className="mt-0.5 line-clamp-1 text-xs text-wp-slate">{feature.description}</p>
          ) : null}
        </div>
        {canWrite ? (
          <button
            type="button"
            className="btn-ghost !p-1.5 text-wp-slate hover:text-wp-red"
            aria-label={`Delete ${feature.name}`}
            onClick={onDelete}
          >
            <Trash2 size={16} />
          </button>
        ) : null}
      </div>
      <Collapsible open={expanded}>
        <div className="border-t border-wp-stone px-4 py-3 text-sm text-wp-slate">
          {feature.description ? (
            <p className="whitespace-pre-wrap">{feature.description}</p>
          ) : (
            <p className="italic text-wp-slate/60">No description.</p>
          )}
        </div>
      </Collapsible>
    </li>
  );
}

function FeatureCardPreview({ feature }: { feature: FeatureGroupFeature }) {
  return (
    <div className="rounded-md border border-wp-stone bg-white px-3 py-2 shadow-lg">
      <span className="text-[11px] font-semibold tabular-nums text-wp-slate">#{feature.rank + 1}</span>
      <span className="ml-2 font-medium text-wp-ink">{feature.name}</span>
    </div>
  );
}
