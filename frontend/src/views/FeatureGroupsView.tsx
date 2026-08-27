import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { NameDescriptionModal } from "../components/NameDescriptionModal";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { useAppDialog } from "../components/AppDialogProvider";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useCanWrite, useFeatureGroups, useIsAdmin, useMe } from "../lib/queries";
import type { FeatureGroupSummary } from "../lib/types";

function sortGroups(groups: FeatureGroupSummary[]): FeatureGroupSummary[] {
  return groups.slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export function FeatureGroupsView() {
  const groups = useFeatureGroups();
  const canWrite = useCanWrite();
  const isAdmin = useIsAdmin();
  const me = useMe();
  const qc = useQueryClient();
  const { confirm } = useAppDialog();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const dragSnapshotRef = useRef<FeatureGroupSummary[] | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const list = sortGroups(groups.data ?? []);

  const createMutation = useMutation({
    mutationFn: () =>
      api<FeatureGroupSummary>("/feature-groups", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      }),
    onSuccess: (row) => {
      setName("");
      setDescription("");
      setShowCreateModal(false);
      qc.setQueryData<FeatureGroupSummary[]>(["featureGroups"], (prev) =>
        prev ? [row, ...prev.filter((g) => g.id !== row.id)] : [row],
      );
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (order: string[]) =>
      api<FeatureGroupSummary[]>("/feature-groups/reorder", {
        method: "POST",
        body: JSON.stringify({ order }),
      }),
    onError: () => {
      if (dragSnapshotRef.current) {
        qc.setQueryData(["featureGroups"], dragSnapshotRef.current);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/feature-groups/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      qc.setQueryData<FeatureGroupSummary[]>(["featureGroups"], (prev) =>
        prev ? prev.filter((g) => g.id !== id) : prev,
      );
    },
  });

  function canDeleteGroup(group: FeatureGroupSummary): boolean {
    return canWrite && (isAdmin || group.created_by === me.data?.id);
  }

  async function handleDelete(group: FeatureGroupSummary) {
    if (
      !(await confirm({
        title: `Delete "${group.name}"?`,
        description:
          "This permanently removes the group and all features inside it. This cannot be undone.",
        confirmLabel: "Delete group",
        destructive: true,
      }))
    ) {
      return;
    }
    deleteMutation.mutate(group.id);
  }

  function handleDragStart() {
    dragSnapshotRef.current = qc.getQueryData<FeatureGroupSummary[]>(["featureGroups"]) ?? null;
  }

  function handleDragEnd(e: DragEndEvent) {
    const snapshot = dragSnapshotRef.current;
    dragSnapshotRef.current = null;
    if (!canWrite || !snapshot) return;

    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const oldIdx = list.findIndex((g) => g.id === active.id);
    const newIdx = list.findIndex((g) => g.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;

    const reordered = arrayMove(list, oldIdx, newIdx).map((g, i) => ({ ...g, position: i }));
    qc.setQueryData<FeatureGroupSummary[]>(["featureGroups"], reordered);
    reorderMutation.mutate(reordered.map((g) => g.id));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader tabKey="feature_groups" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {canWrite ? (
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={() => setShowCreateModal(true)}>
                <Plus size={16} className="mr-1 inline" />
                New feature group
              </button>
            </div>
          ) : null}

          {groups.isLoading ? (
            <p className="text-sm text-wp-slate">Loading…</p>
          ) : groups.isError ? (
            <p className="text-sm text-wp-red">Couldn&apos;t load feature groups.</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-wp-slate">
              No feature groups yet.{canWrite ? " Create one to start ranking proposed features." : ""}
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={list.map((g) => g.id)} strategy={verticalListSortingStrategy}>
                <ul className="divide-y divide-wp-stone rounded-md border border-wp-stone bg-white">
                  {list.map((group) => (
                    <SortableGroupRow
                      key={group.id}
                      group={group}
                      canWrite={canWrite}
                      canDelete={canDeleteGroup(group)}
                      onDelete={() => void handleDelete(group)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {showCreateModal ? (
        <NameDescriptionModal
          title="New feature group"
          nameFieldId="feature-group-name"
          descriptionFieldId="feature-group-desc"
          name={name}
          onNameChange={setName}
          description={description}
          onDescriptionChange={setDescription}
          onClose={() => setShowCreateModal(false)}
          canSubmit={name.trim().length > 0}
          onSubmit={() => createMutation.mutate()}
          mutation={createMutation}
          submitLabel="Create"
        />
      ) : null}
    </div>
  );
}

function SortableGroupRow({
  group,
  canWrite,
  canDelete,
  onDelete,
}: {
  group: FeatureGroupSummary;
  canWrite: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
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
        "flex items-center gap-2 px-3 py-3",
        isDragging && "z-10 bg-white shadow-md",
      )}
    >
      {canWrite ? (
        <button
          type="button"
          className="btn-ghost !cursor-grab !p-1 text-wp-slate active:!cursor-grabbing"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} />
        </button>
      ) : (
        <span className="w-7" />
      )}
      <div className="min-w-0 flex-1">
        <Link
          to={`/feature-groups/${group.id}`}
          className="font-medium text-wp-ink hover:text-wp-red hover:underline"
        >
          {group.name}
        </Link>
        {group.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-wp-slate">{group.description}</p>
        ) : null}
        <p className="mt-1 text-[11px] text-wp-slate/80">
          {group.feature_count} feature{group.feature_count === 1 ? "" : "s"} · {group.creator_name}
        </p>
      </div>
      {canDelete ? (
        <button
          type="button"
          className="btn-ghost !p-1.5 text-wp-slate hover:text-wp-red"
          aria-label={`Delete ${group.name}`}
          onClick={onDelete}
        >
          <Trash2 size={16} />
        </button>
      ) : null}
    </li>
  );
}
