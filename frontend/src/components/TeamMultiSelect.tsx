import * as Popover from "@radix-ui/react-popover";
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
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, ChevronDown, GripVertical, Star, X } from "lucide-react";
import { useMemo } from "react";
import type { Team } from "../lib/types";
import { cn } from "../lib/cn";

/**
 * Multi-select for team memberships. Trigger shows the picked teams as
 * color-tagged chips; the popover has a checkbox list. Users can also
 * remove a team by clicking the × on its chip.
 *
 * Chip order is meaningful — PMs rank the contributing teams primary →
 * secondary → tertiary and every downstream renderer (Board card,
 * roadmap accent, KPI report, status report) mirrors that order. When
 * two or more teams are assigned and the picker is editable, each chip
 * carries a small grip on the left; dragging it reorders the chip and
 * fires `onChange` with the new array so the existing PATCH plumbing
 * ships the new order to the server.
 *
 * The index-0 chip (whenever there are 2+ teams) also carries a
 * small "Primary" badge + star glyph. The Roadmap groups items by
 * their primary team only, so this affordance tells the PM which
 * team drives the item's roadmap placement and how to change it
 * (drag another chip to the front).
 */
export function TeamMultiSelect({
  value,
  onChange,
  teams,
  disabled,
  emptyText = "— No teams —",
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  teams: Team[];
  disabled?: boolean;
  emptyText?: string;
  className?: string;
}) {
  // Look up selected teams while PRESERVING `value` order — the chip
  // sequence IS the project's team ranking. Filtering the catalog
  // by `value` (as an earlier version did) would silently re-sort by
  // catalog order and hide the reorder feature entirely.
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const selectedTeams = useMemo(
    () => value.map((id) => teamsById.get(id)).filter((t): t is Team => !!t),
    [value, teamsById],
  );

  // Only enable drag-to-reorder when the user has write permission and
  // there are at least two chips to reorder. A single chip renders as
  // it did before this feature — no grip clutter.
  const reorderEnabled = !disabled && selectedTeams.length >= 2;

  const sensors = useSensors(
    // Same activation distance as every other sortable list in the app
    // (SortLaneModal, RoadmapHelper, KpiPicker) — 4px is comfortable
    // enough that a plain click on the grip doesn't accidentally
    // trigger a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function toggle(id: string) {
    if (value.includes(id)) onChange(value.filter((v) => v !== id));
    else onChange([...value, id]);
  }

  function remove(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onChange(value.filter((v) => v !== id));
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = value.indexOf(String(active.id));
    const newIdx = value.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    onChange(arrayMove(value, oldIdx, newIdx));
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        disabled={disabled}
        className={cn(
          "input flex min-h-[2.25rem] w-full flex-wrap items-center gap-1 pr-8 text-left",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
      >
        {selectedTeams.length ? (
          reorderEnabled ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={selectedTeams.map((t) => t.id)}
                strategy={horizontalListSortingStrategy}
              >
                {selectedTeams.map((t, i) => (
                  <SortableTeamChip
                    key={t.id}
                    team={t}
                    isPrimary={i === 0}
                    onRemove={(e) => remove(t.id, e)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            selectedTeams.map((t, i) => (
              <StaticTeamChip
                key={t.id}
                team={t}
                // Only badge the primary chip when there's more than
                // one team assigned — a single chip has no "primary"
                // vs "secondary" to disambiguate, so the star would
                // read as decoration and pointlessly crowd the row.
                isPrimary={i === 0 && selectedTeams.length > 1}
                onRemove={disabled ? undefined : (e) => remove(t.id, e)}
              />
            ))
          )
        ) : (
          <span className="text-wp-slate">{emptyText}</span>
        )}
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-wp-slate" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-72 w-64 overflow-y-auto rounded-md border border-wp-stone bg-white p-1 shadow-lg"
        >
          {teams.length === 0 ? (
            <p className="px-2 py-3 text-xs text-wp-slate">No teams defined yet.</p>
          ) : (
            teams.map((t) => {
              const checked = value.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggle(t.id)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-wp-ink outline-none hover:bg-wp-stone/40"
                >
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 items-center justify-center rounded border",
                      checked ? "text-white" : "text-transparent",
                    )}
                    style={{
                      borderColor: t.color,
                      background: checked ? t.color : "transparent",
                    }}
                  >
                    <Check size={12} />
                  </span>
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: t.color }} aria-hidden />
                  <span className="flex-1">{t.name}</span>
                </button>
              );
            })
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The visible bits every chip shares — colored border, tinted bg,
 * dot marker, name, and the remove ×. Factored out because both the
 * static single-chip case and the sortable multi-chip case render
 * an identical body; only the wrapper element and the optional grip
 * differ.
 *
 * When `isPrimary` is true the chip carries a small filled star in
 * place of the color dot so the PM sees which chip drives roadmap
 * placement at a glance. Primary status = index 0 in the ordered
 * `teams` array; reordering the chips (drag the grip) is what
 * changes the primary designation.
 */
function ChipBody({
  team,
  isPrimary,
  onRemove,
}: {
  team: Team;
  isPrimary: boolean;
  onRemove?: (e: React.MouseEvent) => void;
}) {
  return (
    <>
      {isPrimary ? (
        <Star
          size={10}
          className="fill-current"
          aria-label="Primary team"
          role="img"
        />
      ) : (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: team.color }}
        />
      )}
      <span className="text-wp-ink">{team.name}</span>
      {isPrimary ? (
        <span
          className="rounded-sm border border-current px-1 py-0 text-[9px] font-semibold uppercase tracking-wide"
          title="Primary team — drives roadmap group placement. Drag chips to change the primary."
        >
          Primary
        </span>
      ) : null}
      {onRemove ? (
        <span
          role="button"
          aria-label={`Remove ${team.name}`}
          onClick={onRemove}
          className="ml-0.5 rounded p-0.5 text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink"
        >
          <X size={10} />
        </span>
      ) : null}
    </>
  );
}

/**
 * Non-draggable chip — rendered when disabled OR when only one team
 * is assigned (nothing to reorder). Matches the original visual.
 */
function StaticTeamChip({
  team,
  isPrimary,
  onRemove,
}: {
  team: Team;
  isPrimary: boolean;
  onRemove?: (e: React.MouseEvent) => void;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
      style={{ borderColor: team.color, background: `${team.color}18`, color: team.color }}
    >
      <ChipBody team={team} isPrimary={isPrimary} onRemove={onRemove} />
    </span>
  );
}

/**
 * Draggable chip — same visual as the static chip plus a small
 * left-side grip. The grip carries dnd-kit's drag listeners; a
 * pure click on it (no 4px movement) is stopped from bubbling so
 * the enclosing Popover.Trigger doesn't open the picker when the
 * user was just adjusting a chip's order.
 */
function SortableTeamChip({
  team,
  isPrimary,
  onRemove,
}: {
  team: Team;
  isPrimary: boolean;
  onRemove: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: team.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    borderColor: team.color,
    background: `${team.color}18`,
    color: team.color,
  };
  return (
    <span
      ref={setNodeRef}
      style={style}
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder ${team.name}`}
        // Non-drag clicks on the grip must not bubble to the
        // Popover.Trigger — otherwise a stray tap would flip the
        // picker open right after the user finished reordering.
        onClick={(e) => e.stopPropagation()}
        className="cursor-grab rounded p-0.5 text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink active:cursor-grabbing"
      >
        <GripVertical size={10} />
      </span>
      <ChipBody team={team} isPrimary={isPrimary} onRemove={onRemove} />
    </span>
  );
}
