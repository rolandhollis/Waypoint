import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { readableOn, tint } from "../lib/colors";
import type { Project, SwimLane, Team } from "../lib/types";
import { Collapsible } from "./Collapsible";
import { MutationErrorBanner } from "./MutationErrorBanner";

/**
 * "Sort lane" modal for the Board view.
 *
 * Presents every project in a single swim lane (already narrowed to
 * the caller's filter set) as a vertical, drag-to-reorder list. On
 * submit, ships the final id array to POST /projects/reorder-lane,
 * which reindexes positions atomically server-side.
 *
 * Design notes:
 *   * The list is a *subset* view. The server blends the sorted
 *     subset with the un-filtered tail of the lane on commit, so the
 *     user only sorts what they can see and rows outside the filter
 *     stay in their existing relative order.
 *   * We snapshot the incoming `projects` prop into local state on
 *     mount so live cache updates from other users' actions don't
 *     yank rows around while the caller is mid-sort. Discarding the
 *     dialog throws away the local edits — no partial sort commits.
 *   * The submit path invalidates ["projects"] rather than optimising
 *     the cache: an atomic bulk reorder is cheap to re-fetch, and the
 *     board's own drag-and-drop code already assumes the cache is the
 *     source of truth for positions.
 */
export function SortLaneModal({
  lane,
  projects,
  teams,
  onClose,
}: {
  lane: SwimLane;
  /** Lane members after filter application, in their current visible order. */
  projects: Project[];
  /** Full team catalog — we look up team chip data by id. */
  teams: Team[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Snapshot on mount; subsequent prop changes are intentionally
  // ignored. Keying by `lane.id` guarantees the local state resets if
  // the same modal instance is somehow reused for another lane.
  const [ordered, setOrdered] = useState<Project[]>(() => [...projects]);
  // Per-row description expansion state. Ephemeral: reset whenever the
  // dialog closes and remounts. Keyed by project id so the set survives
  // reordering.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const sensors = useSensors(
    // Small activation distance mirrors the Board's own drag setup, so
    // clicks-vs-drags on the list rows feel consistent.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = ordered.findIndex((p) => p.id === active.id);
    const newIdx = ordered.findIndex((p) => p.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    setOrdered((prev) => arrayMove(prev, oldIdx, newIdx));
  }

  const commit = useMutation({
    mutationFn: () =>
      api<{ ok: true }>("/projects/reorder-lane", {
        method: "POST",
        body: JSON.stringify({
          swim_lane_id: lane.id,
          order: ordered.map((p) => p.id),
        }),
      }),
    onSuccess: () => {
      // Refetch rather than optimistically patch — a full-lane reorder
      // touches N rows and the Board's drag code already treats the
      // ["projects"] cache as authoritative for positions. Cheap
      // enough that the visible flicker is negligible.
      qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  // Suppress the submit CTA when the order hasn't actually changed —
  // no need to hit the server for a no-op, and it doubles as a
  // "you haven't made any edits yet" affordance.
  const isDirty = useMemo(() => {
    if (ordered.length !== projects.length) return true;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i]!.id !== projects[i]!.id) return true;
    }
    return false;
  }, [ordered, projects]);

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white shadow-xl">
          <div className="flex items-start justify-between border-b border-wp-stone px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-wp-ink">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: lane.color ?? "#94a3b8" }}
                />
                Sort “{lane.name}”
              </Dialog.Title>
              <p className="mt-1 text-xs text-wp-slate">
                Drag items into the desired order, then Save. Items hidden by the current filters keep their existing order and are appended after your sorted items.
              </p>
            </div>
            <button aria-label="Close" className="btn-ghost !p-1" onClick={onClose}>
              <X size={18} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
            {ordered.length === 0 ? (
              <p className="rounded border border-dashed border-wp-stone p-6 text-center text-sm text-wp-slate">
                No items in this lane match the current filters.
              </p>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={ordered.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                  <ol className="space-y-1">
                    {ordered.map((p, i) => (
                      <SortRow
                        key={p.id}
                        project={p}
                        index={i}
                        teamsById={teamsById}
                        expanded={expandedIds.has(p.id)}
                        onToggleExpanded={() => toggleExpanded(p.id)}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            )}
          </div>

          <MutationErrorBanner mutation={commit} className="mx-5" />

          <div className="flex items-center justify-end gap-2 border-t border-wp-stone px-5 py-3">
            <button
              className="btn-secondary"
              onClick={onClose}
              disabled={commit.isPending}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => commit.mutate()}
              disabled={!isDirty || commit.isPending || ordered.length === 0}
              title={!isDirty ? "No changes to save" : undefined}
            >
              {commit.isPending ? "Saving…" : "Save order"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SortRow({
  project,
  index,
  teamsById,
  expanded,
  onToggleExpanded,
}: {
  project: Project;
  index: number;
  teamsById: Map<string, Team>;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.75 : 1,
  };
  const projectTeams = project.teams
    .map((id) => teamsById.get(id))
    .filter((t): t is Team => !!t);

  // Two-line row: line 1 holds handle, rank, title (left) and team
  // chips (right); line 2 nests under the title inside the same
  // flex-1 min-w-0 wrapper so the description visually associates
  // with the title rather than the drag/rank column. Row stays dense
  // — description is truncated to a single line and omitted when
  // empty so blank descriptions don't reserve vertical space. When
  // the description is expanded via the chevron on line 1, it wraps
  // freely and preserves source newlines.
  const hasDescription = !!project.description;
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-start gap-2 rounded-md border border-wp-stone bg-white px-2 py-1 shadow-sm"
    >
      <button
        {...attributes}
        {...listeners}
        className="mt-0.5 cursor-grab rounded p-0.5 text-wp-slate hover:bg-wp-stone/60 active:cursor-grabbing"
        aria-label={`Drag to reorder ${project.title}`}
      >
        <GripVertical size={12} />
      </button>
      <span className="mt-0.5 w-6 shrink-0 text-right text-[11px] tabular-nums leading-5 text-wp-slate">
        {index + 1}.
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-wp-ink">
            {project.title}
          </span>
          {projectTeams.length ? (
            <div className="flex shrink-0 items-center gap-1">
              {projectTeams.map((t) => {
                // Same luminance-driven readability as the Board card
                // team chip — light hexes need dark text against the
                // tint, dark hexes need white.
                const bg = tint(t.color, 0.14);
                return (
                  <span
                    key={t.id}
                    className="inline-flex max-w-[8rem] items-center truncate rounded-full border px-1.5 py-0 text-[10px] leading-4"
                    style={{ borderColor: t.color, background: bg, color: readableOn(bg) }}
                    title={t.name}
                  >
                    {t.name}
                  </span>
                );
              })}
            </div>
          ) : null}
          {hasDescription ? (
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} description of ${project.title}`}
              title={`${expanded ? "Collapse" : "Expand"} description of ${project.title}`}
              className="btn-ghost mt-0.5 shrink-0 !p-0.5 text-wp-slate"
            >
              <ChevronDown
                size={13}
                className={cn(
                  "transition-transform duration-200 ease-out motion-reduce:transition-none",
                  expanded && "rotate-180",
                )}
              />
            </button>
          ) : null}
        </div>
        {hasDescription ? (
          <>
            {/* Two paired Collapsibles — the truncated preview and
                the full pre-wrapped copy cross-fade via height so
                the row's overall height still animates smoothly. */}
            <Collapsible open={!expanded}>
              <span
                className="block truncate text-xs text-wp-slate"
                title={project.description}
              >
                {project.description}
              </span>
            </Collapsible>
            <Collapsible open={expanded}>
              <span className="block whitespace-pre-wrap text-xs text-wp-slate">
                {project.description}
              </span>
            </Collapsible>
          </>
        ) : null}
      </div>
    </li>
  );
}
