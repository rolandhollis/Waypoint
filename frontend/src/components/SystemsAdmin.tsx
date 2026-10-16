import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { ArrowDownAZ, ChevronRight, GripVertical, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { SYSTEM_PALETTE } from "../lib/colors";
import { useSystems } from "../lib/queries";
import type { System } from "../lib/types";
import { useAppDialog } from "./AppDialogProvider";
import { MutationErrorBanner } from "./MutationErrorBanner";

function alphaSortIdsByName<T extends { id: string; name: string }>(items: T[]): string[] {
  return items
    .slice()
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    )
    .map((x) => x.id);
}

function isAlphabetical<T extends { name: string }>(items: T[]): boolean {
  if (items.length < 2) return true;
  for (let i = 1; i < items.length; i++) {
    if (
      items[i - 1]!.name.localeCompare(items[i]!.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }) > 0
    ) {
      return false;
    }
  }
  return true;
}

function nextPaletteColor(used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  for (const c of SYSTEM_PALETTE) {
    if (!taken.has(c.toLowerCase())) return c;
  }
  return SYSTEM_PALETTE[used.length % SYSTEM_PALETTE.length]!;
}

/**
 * Admin catalog of systems — same UX shape as KPIs (drag reorder,
 * collapsed description, create form behind Add). A system is assigned
 * to at most one product area (team) on Plan → Team.
 */
export function SystemsAdmin() {
  const { confirm } = useAppDialog();
  const systems = useSystems();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(() =>
    nextPaletteColor((systems.data ?? []).map((s) => s.color)),
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function closeCreate() {
    setShowCreate(false);
    setName("");
    setDescription("");
    setColor(nextPaletteColor((systems.data ?? []).map((s) => s.color)));
  }

  const create = useMutation({
    mutationFn: () =>
      api<System>("/systems", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: description.trim() || undefined,
          color,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["systems"] });
      closeCreate();
    },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<System> }) =>
      api<System>(`/systems/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["systems"] });
      qc.invalidateQueries({ queryKey: ["productManagers"] });
    },
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api<System[]>("/systems/reorder", { method: "POST", body: JSON.stringify({ order: ids }) }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["systems"] });
      const prev = qc.getQueryData<System[]>(["systems"]);
      if (prev) {
        const byId = new Map(prev.map((s) => [s.id, s]));
        const next = ids.map((id, i) => ({ ...(byId.get(id) as System), order: i })).filter(Boolean);
        qc.setQueryData<System[]>(["systems"], next);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["systems"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["systems"] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/systems/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["systems"] });
      qc.invalidateQueries({ queryKey: ["productManagers"] });
    },
  });

  function handleDragEnd(e: DragEndEvent) {
    if (!systems.data) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = systems.data.findIndex((s) => s.id === active.id);
    const newIdx = systems.data.findIndex((s) => s.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    reorder.mutate(arrayMove(systems.data, oldIdx, newIdx).map((s) => s.id));
  }

  async function handleDelete(s: System) {
    if (
      !(await confirm({
        title: `Delete "${s.name}"?`,
        description: s.team_id
          ? "This system will be removed from its product area on Plan → Team."
          : undefined,
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    del.mutate(s.id);
  }

  const list = systems.data ?? [];
  const canSort = list.length >= 2 && !isAlphabetical(list);

  return (
    <section className="card-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Systems</h2>
          <p className="mt-1 text-xs text-wp-slate">
            Platforms and products owned by a product area. Drag to reorder —
            assignment happens on <span className="font-medium text-wp-ink">Plan → Team</span>.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={!canSort || reorder.isPending}
            onClick={() => reorder.mutate(alphaSortIdsByName(list))}
          >
            <ArrowDownAZ size={13} />
            Sort A→Z
          </button>
          {!showCreate ? (
            <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
              Add system
            </button>
          ) : null}
        </div>
      </div>
      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={patch} className="mt-3" />
      <MutationErrorBanner mutation={reorder} className="mt-3" />
      <MutationErrorBanner mutation={del} className="mt-3" />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={list.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="mt-3 divide-y divide-wp-stone">
            {list.map((s) => (
              <SortableSystemRow
                key={s.id}
                system={s}
                onRecolor={(v) => patch.mutate({ id: s.id, body: { color: v } })}
                onRename={(v) => patch.mutate({ id: s.id, body: { name: v } })}
                onRedescribe={(v) => patch.mutate({ id: s.id, body: { description: v } })}
                onDelete={() => handleDelete(s)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {showCreate ? (
        <div className="mt-4 grid grid-cols-[1fr_auto_auto] items-end gap-2 rounded-md border border-wp-stone bg-wp-stone/10 p-3">
          <label className="text-xs font-medium text-wp-slate">
            New system name
            <input
              className="input mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="text-xs font-medium text-wp-slate">
            Color
            <input
              type="color"
              className="mt-1 h-8 w-16 cursor-pointer rounded border border-wp-stone"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={closeCreate} disabled={create.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Adding…" : "Add system"}
            </button>
          </div>
          <label className="col-span-3 text-xs font-medium text-wp-slate">
            Description <span className="text-wp-slate/70">(optional)</span>
            <textarea
              className="input mt-1 min-h-[3rem]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this system cover?"
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}

function SortableSystemRow(props: {
  system: System;
  onRecolor: (v: string) => void;
  onRename: (v: string) => void;
  onRedescribe: (v: string) => void;
  onDelete: () => void;
}) {
  const { system, onRecolor, onRename, onRedescribe, onDelete } = props;
  const [descOpen, setDescOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: system.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="grid grid-cols-[auto_auto_auto_1fr_auto] items-start gap-3 py-2"
    >
      <button
        {...attributes}
        {...listeners}
        className="btn-ghost !p-1 mt-1.5"
        aria-label="Drag to reorder"
      >
        <GripVertical size={14} />
      </button>
      <button
        type="button"
        className="btn-ghost !p-1 mt-1.5 text-wp-slate hover:text-wp-ink"
        onClick={() => setDescOpen((v) => !v)}
        aria-expanded={descOpen}
        aria-label={descOpen ? "Collapse description" : "Expand description"}
      >
        <ChevronRight size={14} className={`transition ${descOpen ? "rotate-90" : ""}`} />
      </button>
      <input
        type="color"
        className="mt-1 h-7 w-10 cursor-pointer rounded border border-wp-stone"
        value={system.color}
        onChange={(e) => onRecolor(e.target.value)}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <input
          key={`name-${system.id}-${system.updated_at}`}
          className="input"
          defaultValue={system.name}
          onBlur={(e) => {
            if (e.target.value !== system.name) onRename(e.target.value);
          }}
        />
        {descOpen ? (
          <textarea
            key={`desc-${system.id}-${system.updated_at}`}
            className="input min-h-[2.5rem] text-xs"
            placeholder="What this system covers (optional)."
            defaultValue={system.description}
            onBlur={(e) => {
              if (e.target.value !== system.description) onRedescribe(e.target.value);
            }}
          />
        ) : null}
      </div>
      <button
        className="btn-ghost !p-1 mt-1.5 text-red-600"
        aria-label="Delete system"
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}
