import * as Popover from "@radix-ui/react-popover";
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, Plus, X } from "lucide-react";
import { useMemo } from "react";
import type { Kpi, ProjectKpiAssignment, TshirtSize } from "../lib/types";
import { cn } from "../lib/cn";

/**
 * Multi-select for KPI assignments — differs from TeamMultiSelect in
 * one important way: the selection order is *user-controlled*. PMs
 * rank their KPIs (primary → secondary → …), so we render selected
 * KPIs as horizontally-arranged draggable chips and preserve that
 * order in the value array.
 *
 * Each chip also carries an optional impact SWAG (t-shirt label from
 * the tenant ladder), matching Dev estimate sizing language.
 *
 * A separate "+ Add KPI" popover exposes any KPI not yet in the
 * selection; picking one appends it to the end of the list.
 */
export function KpiPicker({
  value,
  onChange,
  kpis,
  tshirtSizes,
  disabled,
  className,
}: {
  /** Ordered KPI assignments currently on the project. */
  value: ProjectKpiAssignment[] | undefined | null;
  onChange: (next: ProjectKpiAssignment[]) => void;
  /** Full KPI catalog (from useKpis()). */
  kpis: Kpi[];
  /** Tenant t-shirt ladder for the SWAG select (from useTshirtSizes()). */
  tshirtSizes: TshirtSize[] | undefined;
  disabled?: boolean;
  className?: string;
}) {
  // Tolerate undefined / null defensively: pre-KPI-deploy cached
  // project rows won't have this field, and a downstream .map / .length
  // on undefined would crash the whole detail panel with no error
  // boundary above.
  const assignments = value ?? [];
  const ids = useMemo(() => assignments.map((a) => a.kpi_id), [assignments]);
  const byId = useMemo(() => new Map(kpis.map((k) => [k.id, k])), [kpis]);
  // Preserve the caller's order for the selected list; skip any ids
  // whose KPI has been deleted since the project last saved.
  const selected = useMemo(
    () =>
      assignments
        .map((a) => {
          const kpi = byId.get(a.kpi_id);
          return kpi ? { assignment: a, kpi } : null;
        })
        .filter((x): x is { assignment: ProjectKpiAssignment; kpi: Kpi } => !!x),
    [assignments, byId],
  );
  const unselected = useMemo(
    () => kpis.filter((k) => !ids.includes(k.id)),
    [kpis, ids],
  );

  const sizes = tshirtSizes ?? [];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    onChange(arrayMove(assignments, oldIdx, newIdx));
  }

  function add(id: string) {
    if (ids.includes(id)) return;
    onChange([...assignments, { kpi_id: id, impact_swag: null }]);
  }

  function remove(id: string) {
    onChange(assignments.filter((a) => a.kpi_id !== id));
  }

  function setSwag(id: string, impact_swag: string | null) {
    onChange(
      assignments.map((a) => (a.kpi_id === id ? { ...a, impact_swag } : a)),
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          {selected.map(({ kpi, assignment }, i) => (
            <SortableKpiChip
              key={kpi.id}
              kpi={kpi}
              rank={i + 1}
              impactSwag={assignment.impact_swag}
              sizes={sizes}
              disabled={disabled}
              onRemove={() => remove(kpi.id)}
              onSwagChange={(swag) => setSwag(kpi.id, swag)}
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
  impactSwag,
  sizes,
  disabled,
  onRemove,
  onSwagChange,
}: {
  kpi: Kpi;
  rank: number;
  impactSwag: string | null;
  sizes: TshirtSize[];
  disabled?: boolean;
  onRemove: () => void;
  onSwagChange: (swag: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: kpi.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const swagTitle = impactSwag
    ? `Impact SWAG: ${impactSwag}`
    : "Impact SWAG unset";
  return (
    <span
      ref={setNodeRef}
      style={{
        ...style,
        borderColor: kpi.color,
        background: `${kpi.color}18`,
      }}
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
      title={`#${rank} · ${kpi.name}${kpi.description ? ` — ${kpi.description}` : ""} · ${swagTitle}`}
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
      {disabled ? (
        <span
          className={cn(
            "rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            impactSwag ? "bg-white/70 text-wp-ink" : "text-wp-slate/70",
          )}
        >
          {impactSwag ?? "—"}
        </span>
      ) : (
        <select
          aria-label={`Impact SWAG for ${kpi.name}`}
          className="max-w-[3.5rem] cursor-pointer rounded border-0 bg-white/70 py-0.5 pl-1 pr-0 text-[10px] font-semibold uppercase tracking-wide text-wp-ink outline-none hover:bg-white"
          value={impactSwag ?? ""}
          onChange={(e) => onSwagChange(e.target.value || null)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <option value="">SWAG</option>
          {sizes.map((s) => (
            <option key={s.id} value={s.label}>
              {s.label}
            </option>
          ))}
        </select>
      )}
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
