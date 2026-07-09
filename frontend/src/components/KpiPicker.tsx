import * as Popover from "@radix-ui/react-popover";
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, Plus, X } from "lucide-react";
import { useMemo } from "react";
import type { Kpi } from "../lib/types";
import { cn } from "../lib/cn";

/**
 * Multi-select for KPI assignments — differs from TeamMultiSelect in
 * one important way: the selection order is *user-controlled*. PMs
 * rank their KPIs (primary → secondary → …), so we render selected
 * KPIs as horizontally-arranged draggable chips and preserve that
 * order in the value array.
 *
 * A separate "+ Add KPI" popover exposes any KPI not yet in the
 * selection; picking one appends it to the end of the list.
 */
export function KpiPicker({
  value,
  onChange,
  kpis,
  disabled,
  className,
}: {
  /** Ordered list of KPI ids currently assigned to the project. */
  value: string[] | undefined | null;
  onChange: (next: string[]) => void;
  /** Full KPI catalog (from useKpis()). */
  kpis: Kpi[];
  disabled?: boolean;
  className?: string;
}) {
  // Tolerate undefined / null defensively: pre-KPI-deploy cached
  // project rows won't have this field, and a downstream .map / .length
  // on undefined would crash the whole detail panel with no error
  // boundary above.
  const ids = value ?? [];
  const byId = useMemo(() => new Map(kpis.map((k) => [k.id, k])), [kpis]);
  // Preserve the caller's order for the selected list; skip any ids
  // whose KPI has been deleted since the project last saved.
  const selected = useMemo(
    () => ids.map((id) => byId.get(id)).filter((k): k is Kpi => !!k),
    [ids, byId],
  );
  const unselected = useMemo(
    () => kpis.filter((k) => !ids.includes(k.id)),
    [kpis, ids],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    onChange(arrayMove(ids, oldIdx, newIdx));
  }

  function add(id: string) {
    if (ids.includes(id)) return;
    onChange([...ids, id]);
  }

  function remove(id: string) {
    onChange(ids.filter((v) => v !== id));
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          {selected.map((k, i) => (
            <SortableKpiChip
              key={k.id}
              kpi={k}
              rank={i + 1}
              disabled={disabled}
              onRemove={() => remove(k.id)}
            />
          ))}
        </SortableContext>
      </DndContext>

      {selected.length === 0 && disabled ? (
        <span className="text-xs text-wp-slate">— No KPIs assigned —</span>
      ) : null}

      {!disabled ? (
        <Popover.Root>
          <Popover.Trigger
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-wp-stone px-2 py-0.5 text-xs text-wp-slate hover:border-wp-red/60 hover:text-wp-red"
            disabled={unselected.length === 0}
          >
            <Plus size={12} />
            {unselected.length === 0
              ? "All KPIs added"
              : selected.length === 0 ? "Add a KPI" : "Add another"}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={4}
              className="z-50 max-h-72 w-72 overflow-y-auto rounded-md border border-wp-stone bg-white p-1 shadow-lg"
            >
              {unselected.length === 0 ? (
                <p className="px-2 py-3 text-xs text-wp-slate">
                  Every KPI is already tracked on this project.
                </p>
              ) : (
                unselected.map((k) => (
                  <Popover.Close asChild key={k.id}>
                    <button
                      type="button"
                      onClick={() => add(k.id)}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-wp-ink outline-none hover:bg-wp-stone/40"
                    >
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: k.color }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{k.name}</span>
                      <Check size={12} className="opacity-0 group-hover:opacity-100" />
                    </button>
                  </Popover.Close>
                ))
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}

/** One draggable KPI chip in the selected-order list. */
function SortableKpiChip({
  kpi,
  rank,
  disabled,
  onRemove,
}: {
  kpi: Kpi;
  rank: number;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: kpi.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <span
      ref={setNodeRef}
      style={{
        ...style,
        borderColor: kpi.color,
        background: `${kpi.color}18`,
      }}
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
      title={`#${rank} · ${kpi.name}${kpi.description ? ` — ${kpi.description}` : ""}`}
    >
      {!disabled ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag to reorder ${kpi.name}`}
          className="cursor-grab rounded p-0.5 text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink active:cursor-grabbing"
        >
          <GripVertical size={10} />
        </button>
      ) : null}
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: kpi.color }}
      />
      <span className="text-wp-ink">{kpi.name}</span>
      {!disabled ? (
        <button
          type="button"
          aria-label={`Remove ${kpi.name}`}
          onClick={onRemove}
          className="ml-0.5 rounded p-0.5 text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink"
        >
          <X size={10} />
        </button>
      ) : null}
    </span>
  );
}
