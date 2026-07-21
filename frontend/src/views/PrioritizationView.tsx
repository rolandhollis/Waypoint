import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { format } from "date-fns";
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GripVertical,
  Info,
  Star,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { readableOn, tint } from "../lib/colors";
import {
  useCanWrite,
  usePrioritization,
  useTeams,
  type PrioritizationRow,
} from "../lib/queries";
import { ProjectDetailPanel } from "../components/ProjectDetailPanel";
import {
  FINDER_PREFIX,
  PrioritizationFinderPanel,
} from "../components/PrioritizationFinderPanel";

/**
 * Prioritization tab -- single global 1..N ranked list of every
 * roadmap-eligible project across teams, owners, and swim lanes.
 *
 * The view is laid out as two columns inside a single DndContext
 * so drags can cross the column boundary:
 *
 *   * Column A (2/3 width, left): the canonical ranked 1..N list.
 *     Drag rows within A to reorder; drops fire PUT
 *     /api/prioritization which rewrites `global_priority` AND
 *     cascades the resulting order onto per-swim-lane `position`
 *     values (so Board / Roadmap Priority sort track the user's
 *     global choice in the same transaction).
 *   * Column B (1/3 width, right): a compact "finder" panel with
 *     its own search / sort / filter controls (see
 *     PrioritizationFinderPanel). Rows in B are draggable but
 *     their intra-B order is NOT persisted. Dropping a B item on
 *     any A row splices it into that new global rank — because
 *     every B item is also in A this is functionally an internal
 *     move. Dropping within B, or dropping A → B, is silently
 *     ignored.
 *
 * See backend/src/routes/prioritization.ts for the eligibility
 * predicate and the cascade math.
 */
export function PrioritizationView() {
  const canWrite = useCanWrite();
  const prioritization = usePrioritization();
  const teams = useTeams();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Local optimistic mirror of the server list. Reseeded whenever
  // `prioritization.data` changes (poll refetch, mutation resolve,
  // etc.) so a background update by another user surfaces even
  // when the tab is idle.
  const [localOrder, setLocalOrder] = useState<PrioritizationRow[]>([]);
  useEffect(() => {
    if (prioritization.data) setLocalOrder(prioritization.data);
  }, [prioritization.data]);

  // Per-row expand state. Keyed by project id; a row toggles its
  // own entry, so multiple rows can be open simultaneously
  // (matches the user's mental model of scanning descriptions).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Detail-panel selection. Populated by the row's "Open" button
  // (the row body itself is click-to-expand and MUST NOT open the
  // panel per the product spec).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Bookmarkable / shareable ?project=<id> URL param, mirroring
  // the Board convention. Reading is one-shot on mount; writing
  // is handled by setSelectedId directly.
  useEffect(() => {
    const p = searchParams.get("project");
    if (p) {
      setSelectedId(p);
      const next = new URLSearchParams(searchParams);
      next.delete("project");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toast for cross-cutting errors (drift rejections, network
  // failures). Auto-clears after 6s.
  const [toast, setToast] = useState<
    | { message: string; variant: "error" | "info" | "success" }
    | null
  >(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Raw drag active id (kept as-is: raw project id for column-A
  // rows, `finder:<id>` for column-B rows). Powers the DragOverlay
  // and the "dim the finder twin" hint in Column B.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Snapshot of `localOrder` captured at drag start. Used to:
  //   (a) revert to the pre-drag layout if the drag is cancelled
  //       (Escape, dropped outside any droppable, dropped on B),
  //   (b) freeze the Column-B finder view during the drag so its
  //       ranks/sort don't reshuffle beneath the cursor while
  //       Column A is animating a pending-drop preview, and
  //   (c) detect a "dragged away and back to origin" no-op on
  //       drop, since `localOrder` may have been mutated by
  //       `handleDragOver` in-between.
  const [dragSnapshot, setDragSnapshot] = useState<PrioritizationRow[] | null>(null);

  const sensors = useSensors(
    // 4px activation distance mirrors the Board / RoadmapHelper
    // pattern so a plain click on the row (to expand) never
    // accidentally starts a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * Optimistic PATCH for the Column-A star toggle. Flips
   * `is_key_strategic` on the target project, mirrors the change
   * into `localOrder` immediately so the star fills before the
   * server round-trip, and rolls back the mirror on error.
   *
   * The row-render side effect (star colour) is what the user
   * sees; the shared project cache is also invalidated so any
   * concurrent detail-panel view of the same project catches up
   * on the next render.
   */
  const strategicToggle = useMutation({
    mutationFn: async (args: { projectId: string; next: boolean }) =>
      api(`/projects/${args.projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ is_key_strategic: args.next }),
      }),
    onMutate: (args): { previous: PrioritizationRow[] } => {
      const previous = localOrder;
      setLocalOrder((cur) =>
        cur.map((r) =>
          r.id === args.projectId ? { ...r, is_key_strategic: args.next } : r,
        ),
      );
      return { previous };
    },
    onError: (err, _args, ctx) => {
      if (ctx && (ctx as { previous?: PrioritizationRow[] }).previous) {
        setLocalOrder((ctx as { previous: PrioritizationRow[] }).previous);
      }
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not update key strategic flag.";
      setToast({ message, variant: "error" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["prioritization"] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (ordered_ids: string[]) =>
      api<{ updated: number }>("/prioritization", {
        method: "PUT",
        body: JSON.stringify({ ordered_ids }),
      }),
    onMutate: (): { previous: PrioritizationRow[] } => {
      return { previous: prioritization.data ?? [] };
    },
    onSuccess: () => {
      // Every cross-surface consumer needs to hear about the
      // cascade. Board reads `position`; Roadmap reads
      // position + lane order for its Priority sort; project
      // detail cards read the row itself. Invalidate everything
      // ranked-adjacent rather than surgically picking keys --
      // the wire cost is tiny compared to the risk of a stale
      // surface.
      qc.invalidateQueries({ queryKey: ["prioritization"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err, _ordered, ctx) => {
      // Roll back to the server's last-known snapshot on
      // failure. `ctx.previous` is populated by onMutate above.
      if (ctx && (ctx as { previous?: PrioritizationRow[] }).previous) {
        setLocalOrder((ctx as { previous: PrioritizationRow[] }).previous);
      } else if (prioritization.data) {
        setLocalOrder(prioritization.data);
      }
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Reorder failed. Try again.";
      setToast({ message, variant: "error" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["prioritization"] });
    },
  });

  function handleDragStart(evt: DragStartEvent) {
    setActiveDragId(String(evt.active.id));
    setDragSnapshot(localOrder);
  }

  /**
   * Cross-column (B → A) live preview. As soon as the pointer
   * hovers a row in A while dragging a finder row, splice the
   * dragged project from its current A position to that row's
   * index. Because Column B's items are a subset of Column A's,
   * the project already lives in `localOrder` — a plain
   * `arrayMove` is all that's needed. React re-renders A with the
   * new order and dnd-kit-sortable's `animateLayoutChanges`
   * FLIP-transitions each neighbor into its new slot, giving the
   * same visual polish as an A → A drag.
   *
   * A → A drags are ignored here: the built-in
   * `verticalListSortingStrategy` inside A's SortableContext
   * already animates neighbors from `active` / `over` alone, so
   * mutating `localOrder` mid-drag would fight it.
   *
   * This mirrors BoardView's `handleDragOver` cross-lane preview:
   * mutate the source-of-truth (there: query cache; here:
   * `localOrder`) so the destination container animates via its
   * own SortableContext transforms, then commit or revert on drop
   * / cancel.
   */
  function handleDragOver(evt: DragOverEvent) {
    const { active, over } = evt;
    if (!over) return;

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);

    // Only preview cross-column drags. A → A is animated natively.
    if (!activeIdStr.startsWith(FINDER_PREFIX)) return;
    // Over must be a row in A, not a row in B.
    if (overIdStr.startsWith(FINDER_PREFIX)) return;

    const activeProjectId = activeIdStr.slice(FINDER_PREFIX.length);
    // Cursor over the just-repositioned target row itself — nothing
    // to do, and returning `current` from the setter keeps identity
    // stable so React skips the re-render.
    if (overIdStr === activeProjectId) return;

    setLocalOrder((current) => {
      const sourceIndex = current.findIndex((r) => r.id === activeProjectId);
      const destIndex = current.findIndex((r) => r.id === overIdStr);
      if (sourceIndex < 0 || destIndex < 0) return current;
      if (sourceIndex === destIndex) return current;
      return arrayMove(current, sourceIndex, destIndex);
    });
  }

  /**
   * Drop-decision matrix, resolved by the source column of `active`
   * and the destination column of `over`:
   *
   *   A → A : reorder within A (existing behavior, arrayMove).
   *   B → A : `localOrder` was already mutated by
   *           `handleDragOver` while the pointer moved; commit
   *           whatever position the preview settled on. If the
   *           user dragged away and back to the origin,
   *           `finalIndex === originalIndex` and the PUT is
   *           skipped.
   *   A → B : no-op; revert to snapshot in case dragOver dirtied
   *           anything (it doesn't today, but keeps the invariant
   *           tight).
   *   B → B : no-op, revert to snapshot.
   *   over === null: no-op, revert to snapshot.
   */
  function handleDragEnd(evt: DragEndEvent) {
    const { active, over } = evt;
    setActiveDragId(null);
    const snapshot = dragSnapshot;
    setDragSnapshot(null);

    if (!over) {
      if (snapshot) setLocalOrder(snapshot);
      return;
    }

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);
    const activeFromFinder = activeIdStr.startsWith(FINDER_PREFIX);
    const overIsFinder = overIdStr.startsWith(FINDER_PREFIX);

    // A → B and B → B: dropping onto a finder row is a no-op.
    if (overIsFinder) {
      if (snapshot) setLocalOrder(snapshot);
      return;
    }

    const activeProjectId = activeFromFinder
      ? activeIdStr.slice(FINDER_PREFIX.length)
      : activeIdStr;

    let finalOrder: PrioritizationRow[];
    if (activeFromFinder) {
      // `localOrder` already reflects the pending position from
      // `handleDragOver`; commit as-is.
      finalOrder = localOrder;
    } else {
      // A → A: SortableContext hasn't touched `localOrder` — do
      // the arrayMove here, same as the original behavior.
      const sourceIndex = localOrder.findIndex((p) => p.id === activeProjectId);
      const destIndex = localOrder.findIndex((p) => p.id === overIdStr);
      if (sourceIndex < 0 || destIndex < 0 || sourceIndex === destIndex) return;
      finalOrder = arrayMove(localOrder, sourceIndex, destIndex);
      setLocalOrder(finalOrder);
    }

    // No-op guard: compare against the pre-drag snapshot, not the
    // possibly-mutated `localOrder`, so a "drag out and back" gesture
    // doesn't hit the server.
    if (snapshot) {
      const originalIndex = snapshot.findIndex((r) => r.id === activeProjectId);
      const finalIndex = finalOrder.findIndex((r) => r.id === activeProjectId);
      if (originalIndex >= 0 && originalIndex === finalIndex) return;
    }

    reorderMutation.mutate(finalOrder.map((p) => p.id));
  }

  function handleDragCancel() {
    setActiveDragId(null);
    if (dragSnapshot) setLocalOrder(dragSnapshot);
    setDragSnapshot(null);
  }

  // First-visit auto-seed: if every eligible row is still at the
  // default global_priority=0, run a single PUT that materializes
  // the current display order (server order already sorts by
  // updated_at DESC then id ASC, matching what we're rendering).
  // Only fires once per mount (via ref) so a background refetch
  // that keeps everyone at 0 for some other reason doesn't loop.
  // Skipped when `canWrite` is false -- viewers can't seed on
  // behalf of the workspace.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!canWrite) return;
    if (seededRef.current) return;
    if (!prioritization.data || prioritization.data.length === 0) return;
    const allZero = prioritization.data.every((r) => r.global_priority === 0);
    seededRef.current = true;
    if (!allZero) return;
    reorderMutation.mutate(prioritization.data.map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prioritization.data, canWrite]);

  const teamsById = useMemo(() => {
    const m = new Map<string, { color: string; name: string }>();
    for (const t of teams.data ?? []) m.set(t.id, { color: t.color, name: t.name });
    return m;
  }, [teams.data]);

  // Decode `activeDragId` back to a raw project id (drops the
  // `finder:` prefix for B-sourced drags). null when no drag is
  // in flight. Used both to render the DragOverlay preview and to
  // mark the pending-drop target row in A during a B → A drag.
  const activeDragProjectId = useMemo(() => {
    if (!activeDragId) return null;
    return activeDragId.startsWith(FINDER_PREFIX)
      ? activeDragId.slice(FINDER_PREFIX.length)
      : activeDragId;
  }, [activeDragId]);

  // True while a B → A drag is in flight. Column A's row for the
  // dragged project gets a pending-drop highlight (dashed accent
  // ring + subtle red tint + elevated z-index) so the user can
  // see where the item will land in addition to the DragOverlay
  // pill following the cursor. During an A → A drag, the row
  // that's being dragged is already visually distinct via
  // `useSortable`'s built-in `isDragging` styling, so no extra
  // highlight is applied.
  const isCrossColumnDrag =
    activeDragId !== null && activeDragId.startsWith(FINDER_PREFIX);

  // Look up the row currently being dragged so DragOverlay can
  // render a compact card. Works for both source columns because
  // `active.id` is decoded via FINDER_PREFIX before lookup.
  const activeDragRow = useMemo(() => {
    if (!activeDragProjectId) return null;
    return localOrder.find((r) => r.id === activeDragProjectId) ?? null;
  }, [activeDragProjectId, localOrder]);

  const activeDragRank = useMemo(() => {
    if (!activeDragRow) return 0;
    return localOrder.findIndex((r) => r.id === activeDragRow.id) + 1;
  }, [activeDragRow, localOrder]);

  // Rows fed into the Column-B finder panel. Frozen to the pre-drag
  // snapshot while a drag is in flight so the finder's own filter /
  // sort / rank-badge computations don't churn every frame as
  // `localOrder` mutates through `handleDragOver`. Once the drag
  // resolves (commit or cancel), `dragSnapshot` is cleared and B
  // resumes tracking `localOrder`.
  const finderRows = dragSnapshot ?? localOrder;

  if (prioritization.isLoading) {
    return <div className="p-6 text-sm text-wp-slate">Loading prioritization…</div>;
  }
  if (prioritization.error) {
    return (
      <div className="p-6 text-sm text-wp-red">
        Failed to load prioritization: {(prioritization.error as Error).message}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-wp-stone bg-white/80 px-5 py-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-wp-ink">Prioritization</h1>
            <p className="mt-0.5 text-xs text-wp-slate">
              Drag to reorder. Changes cascade to Board swim-lane order and Roadmap Priority sort.
            </p>
          </div>
          <div className="text-xs text-wp-slate">
            {localOrder.length} eligible initiative{localOrder.length === 1 ? "" : "s"}
          </div>
        </div>
      </header>

      {localOrder.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto mt-10 max-w-lg rounded-md border border-wp-stone bg-white p-6 text-sm text-wp-slate">
            <div className="flex items-start gap-2">
              <Info size={16} className="mt-0.5 shrink-0 text-wp-slate" />
              <div>
                <div className="font-medium text-wp-ink">No eligible initiatives</div>
                <div className="mt-1">
                  No initiatives are currently eligible for prioritization. Items must have all
                  six phase dates set and not be archived, parked, or hidden from the roadmap.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={canWrite ? handleDragStart : undefined}
          onDragOver={canWrite ? handleDragOver : undefined}
          onDragEnd={canWrite ? handleDragEnd : undefined}
          onDragCancel={handleDragCancel}
        >
          {/*
            Layout: single column on mobile (Column A on top,
            Column B below, page-level scroll); a 3-column grid on
            md+ where A is 2/3 and B is 1/3 with their own scroll
            containers. `md:overflow-hidden` on the wrapper hands
            scroll ownership to each column on desktop so long
            lists don't force a viewport scrollbar.
          */}
          <div className="min-h-0 flex-1 overflow-y-auto md:overflow-hidden">
            <div className="grid grid-cols-1 gap-4 p-4 md:h-full md:grid-cols-3 md:gap-6">
              <div className="min-h-0 md:col-span-2 md:overflow-y-auto">
                <SortableContext
                  items={localOrder.map((p) => p.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ol className="divide-y divide-wp-stone rounded-md border border-wp-stone bg-white">
                    {localOrder.map((row, index) => (
                      <SortableRow
                        key={row.id}
                        row={row}
                        rank={index + 1}
                        canWrite={canWrite}
                        isExpanded={expanded.has(row.id)}
                        onToggleExpanded={() => toggleExpanded(row.id)}
                        onOpenDetail={() => setSelectedId(row.id)}
                        onToggleStrategic={() =>
                          strategicToggle.mutate({
                            projectId: row.id,
                            next: !row.is_key_strategic,
                          })
                        }
                        primaryTeam={
                          row.team_ids[0] ? teamsById.get(row.team_ids[0]) ?? null : null
                        }
                        primaryTeamName={row.team_names[0] ?? null}
                        isPendingCrossDrag={
                          isCrossColumnDrag && activeDragProjectId === row.id
                        }
                      />
                    ))}
                  </ol>
                </SortableContext>
              </div>
              <div className="min-h-0 md:col-span-1 md:overflow-hidden">
                <PrioritizationFinderPanel
                  rows={finderRows}
                  teamsById={teamsById}
                  canWrite={canWrite}
                  activeDragId={activeDragId}
                />
              </div>
            </div>
          </div>

          {/*
            DragOverlay renders a floating clone of the dragged row
            so drops from Column B look natural — without an
            overlay the source row appears to "stay behind" while
            dnd-kit only translates the placeholder, which is
            confusing when the drop target lives in a different
            column with a different row layout.
          */}
          <DragOverlay dropAnimation={null}>
            {activeDragRow ? (
              <DragPreview
                row={activeDragRow}
                rank={activeDragRank}
                primaryTeam={
                  activeDragRow.team_ids[0]
                    ? teamsById.get(activeDragRow.team_ids[0]) ?? null
                    : null
                }
                primaryTeamName={activeDragRow.team_names[0] ?? null}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {toast ? (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md px-4 py-2 text-sm shadow-lg",
            toast.variant === "error"
              ? "bg-wp-red text-white"
              : toast.variant === "success"
                ? "bg-emerald-600 text-white"
                : "bg-wp-ink text-white",
          )}
          role="status"
        >
          {toast.message}
        </div>
      ) : null}

      {selectedId ? (
        <ProjectDetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenProject={setSelectedId}
          siblingIds={localOrder.map((p) => p.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * One row in the ranked list. The whole row header is a
 * click-to-expand target -- MUST NOT open the detail panel per
 * the product spec. The trailing "Open" button is the only
 * affordance that lands the user in ProjectDetailPanel; the drag
 * handle (grip icon on the left) is the only pointerdown surface
 * that initiates a drag.
 */
function SortableRow(props: {
  row: PrioritizationRow;
  rank: number;
  canWrite: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onOpenDetail: () => void;
  /**
   * Flip the row's `is_key_strategic` flag. The parent view owns
   * the optimistic mirror + rollback; this row just fires the
   * callback on click and reads the current value from `row`.
   */
  onToggleStrategic: () => void;
  primaryTeam: { color: string; name: string } | null;
  primaryTeamName: string | null;
  /**
   * True when a Column-B finder row for THIS project is currently
   * being dragged over Column A. The row itself has already been
   * spliced into `localOrder` at the pending drop position by
   * `handleDragOver`, so it's visually where the item will land —
   * this flag adds a dashed accent ring + subtle red tint so the
   * user can distinguish "landed here, not committed" from
   * neighboring rows and from a fully-committed drop. During an
   * A → A drag, `useSortable`'s own `isDragging` styling already
   * marks the moving row, so this stays false.
   */
  isPendingCrossDrag: boolean;
}) {
  const {
    row,
    rank,
    canWrite,
    isExpanded,
    onToggleExpanded,
    onOpenDetail,
    onToggleStrategic,
    primaryTeam,
    primaryTeamName,
    isPendingCrossDrag,
  } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Elevate both the actively-dragged row (A → A) and the
    // pending-drop target row (B → A) above their neighbors so the
    // accent ring / dashed border isn't clipped by the sibling
    // `divide-y` border of the parent `<ol>`.
    zIndex: isDragging || isPendingCrossDrag ? 10 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };

  const dateRange = formatDateRange(row.start_date, row.optimization_end_date);
  const chipColor = primaryTeam?.color ?? null;
  const chipBg = chipColor ? tint(chipColor, 0.16) : null;
  const chipFg = chipColor ? readableOn(chipColor) : null;
  const chipBorder = chipColor ? tint(chipColor, 0.4) : null;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative bg-white",
        // Pending-drop landing marker. `ring` is a box-shadow, so
        // it doesn't take layout space and the row doesn't shift
        // by 2px when the highlight comes on. The tint sits above
        // the white bg but under any hover / expand state, and
        // the offset-0 avoids a halo around adjacent rows.
        isPendingCrossDrag &&
          "bg-wp-red/5 ring-2 ring-wp-red ring-offset-0",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.title}`}
        onClick={onToggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpanded();
          }
        }}
        className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-wp-stone/30"
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to rerank"
          title={canWrite ? "Drag to rerank" : "Read-only -- viewers cannot rerank"}
          disabled={!canWrite}
          // Stop propagation so grabbing the handle doesn't also
          // toggle the row expand.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            "shrink-0 rounded p-1 text-wp-slate",
            canWrite
              ? "cursor-grab touch-none hover:bg-wp-stone/50 active:cursor-grabbing"
              : "cursor-not-allowed opacity-40",
          )}
        >
          <GripVertical size={16} />
        </button>

        <span
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-wp-stone/60 text-xs font-semibold text-wp-slate"
          title={`Rank ${rank}`}
        >
          {rank}
        </span>

        {primaryTeamName ? (
          <span
            className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
            style={
              chipColor
                ? {
                    backgroundColor: chipBg ?? undefined,
                    color: chipFg ?? undefined,
                    borderColor: chipBorder ?? undefined,
                  }
                : undefined
            }
            title={primaryTeamName}
          >
            {primaryTeamName}
          </span>
        ) : (
          <span
            className="inline-flex shrink-0 items-center rounded-full border border-dashed border-wp-stone px-2 py-0.5 text-[11px] text-wp-slate/70"
            title="No team assigned"
          >
            No team
          </span>
        )}

        <span className="min-w-0 flex-1 truncate text-sm font-medium text-wp-ink">
          {row.title}
        </span>

        <span className="hidden shrink-0 items-center gap-1 text-xs text-wp-slate sm:inline-flex">
          <Calendar size={12} />
          {dateRange}
        </span>

        {/*
          Inline star toggle for the "Key strategic item" flag. One
          click flips the flag via `onToggleStrategic`; the parent
          view owns the optimistic mirror and rollback on error.
          Filled + red when active, outlined + muted otherwise, so
          the current state is obvious at a glance from the ranked
          list without opening the detail panel. Read-only for
          viewers (button stays visible so they can see the state,
          but disabled prevents the flip).
        */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStrategic();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={!canWrite}
          aria-pressed={row.is_key_strategic}
          aria-label={
            row.is_key_strategic
              ? `Unmark ${row.title} as key strategic`
              : `Mark ${row.title} as key strategic`
          }
          title={
            row.is_key_strategic
              ? "Key strategic item \u2014 click to unmark"
              : canWrite
                ? "Mark as key strategic"
                : "Read-only \u2014 viewers cannot change this"
          }
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded p-1 hover:bg-wp-stone/40 disabled:cursor-not-allowed disabled:opacity-60",
            row.is_key_strategic ? "text-wp-red" : "text-wp-slate/50",
          )}
        >
          <Star
            size={16}
            className={row.is_key_strategic ? "fill-wp-red" : ""}
          />
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetail();
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-wp-stone bg-white px-2 py-1 text-xs text-wp-slate hover:bg-wp-stone/40"
          aria-label={`Open ${row.title}`}
          title="Open project details"
        >
          <ExternalLink size={12} />
          Open
        </button>

        <span className="inline-flex shrink-0 items-center text-wp-slate" aria-hidden>
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </div>

      {isExpanded ? (
        <div className="border-t border-wp-stone/60 bg-wp-stone/10 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-wp-slate sm:hidden">
            <Calendar size={12} />
            {dateRange}
          </div>
          {row.description?.trim() ? (
            <div className="whitespace-pre-wrap text-sm text-wp-ink">{row.description}</div>
          ) : (
            <div className="text-sm italic text-wp-slate/70">No description.</div>
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Lightweight visual double of a ranked row, used inside
 * DragOverlay so the row the user is dragging follows the cursor
 * regardless of which column it originated from. Intentionally
 * simpler than SortableRow — no expand affordance, no "Open"
 * button — so the overlay reads as a floating pill rather than a
 * live interactive row.
 */
function DragPreview(props: {
  row: PrioritizationRow;
  rank: number;
  primaryTeam: { color: string; name: string } | null;
  primaryTeamName: string | null;
}) {
  const { row, rank, primaryTeam, primaryTeamName } = props;
  const dateRange = formatDateRange(row.start_date, row.optimization_end_date);
  const chipColor = primaryTeam?.color ?? null;
  const chipBg = chipColor ? tint(chipColor, 0.16) : null;
  const chipFg = chipColor ? readableOn(chipColor) : null;
  const chipBorder = chipColor ? tint(chipColor, 0.4) : null;

  return (
    <div className="pointer-events-none flex items-center gap-3 rounded-md border border-wp-stone bg-white px-4 py-2 shadow-lg">
      <GripVertical size={16} className="shrink-0 text-wp-slate" />
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-wp-stone/60 text-xs font-semibold text-wp-slate"
      >
        {rank}
      </span>
      {primaryTeamName ? (
        <span
          className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={
            chipColor
              ? {
                  backgroundColor: chipBg ?? undefined,
                  color: chipFg ?? undefined,
                  borderColor: chipBorder ?? undefined,
                }
              : undefined
          }
        >
          {primaryTeamName}
        </span>
      ) : null}
      <span className="max-w-[24rem] truncate text-sm font-medium text-wp-ink">
        {row.title}
      </span>
      <span className="hidden shrink-0 items-center gap-1 text-xs text-wp-slate sm:inline-flex">
        <Calendar size={12} />
        {dateRange}
      </span>
    </div>
  );
}

function formatDateRange(startIso: string, endIso: string): string {
  const start = safeDate(startIso);
  const end = safeDate(endIso);
  if (!start || !end) return `${startIso} → ${endIso}`;
  return `${format(start, "MMM d")} → ${format(end, "MMM d, yyyy")}`;
}

function safeDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
