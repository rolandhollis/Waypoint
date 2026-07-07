import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useMe, useProductAreas, useProjects, useSwimLanes, useUsers } from "../lib/queries";
import type { ProductArea, Project, SwimLane, User } from "../lib/types";

export function AdminSettingsView() {
  const me = useMe();
  if (me.data?.role !== "admin") {
    return <div className="p-6 text-sm text-wp-slate">Admin access required.</div>;
  }
  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <h1 className="text-xl font-semibold text-wp-ink">Admin Settings</h1>
      <SwimLanesAdmin />
      <ProductAreasAdmin />
      <UsersAdmin />
      <ArchivedProjectsAdmin />
    </div>
  );
}

function ArchivedProjectsAdmin() {
  const qc = useQueryClient();
  const all = useQuery({
    queryKey: ["projectsIncludingDeleted"],
    queryFn: () => api<Project[]>("/projects?include_deleted=true"),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api(`/projects/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectsIncludingDeleted"] });
    },
  });
  const archived = (all.data ?? []).filter((p) => p.deleted_at);
  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Archived cards</h2>
      {archived.length === 0 ? (
        <p className="mt-2 text-xs text-wp-slate">No archived cards.</p>
      ) : (
        <ul className="mt-3 divide-y divide-wp-stone">
          {archived.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-wp-ink">{p.title}</div>
                <div className="text-xs text-wp-slate">archived {p.deleted_at?.slice(0, 10)}</div>
              </div>
              <button className="btn-secondary text-xs" onClick={() => restore.mutate(p.id)}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SwimLanesAdmin() {
  const lanes = useSwimLanes();
  const projects = useProjects();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#94a3b8");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const create = useMutation({
    mutationFn: () => api<SwimLane>("/swim-lanes", { method: "POST", body: JSON.stringify({ name, color }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["swimLanes"] }); setName(""); },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<SwimLane> }) => api<SwimLane>(`/swim-lanes/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swimLanes"] }),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api<SwimLane[]>("/swim-lanes/reorder", { method: "POST", body: JSON.stringify({ order: ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swimLanes"] }),
  });
  const del = useMutation({
    mutationFn: (v: { id: string; reassign_to: string | null }) => api(`/swim-lanes/${v.id}`, { method: "DELETE", body: JSON.stringify({ reassign_to: v.reassign_to }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["swimLanes"] }); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  function handleDragEnd(e: DragEndEvent) {
    if (!lanes.data) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = lanes.data.findIndex((l) => l.id === active.id);
    const newIdx = lanes.data.findIndex((l) => l.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reorderedIds = arrayMove(lanes.data, oldIdx, newIdx).map((l) => l.id);
    reorder.mutate(reorderedIds);
  }

  async function handleDelete(lane: SwimLane) {
    const cardCount = (projects.data ?? []).filter((p) => p.swim_lane_id === lane.id && !p.deleted_at).length;
    const others = (lanes.data ?? []).filter((l) => l.id !== lane.id);
    if (cardCount > 0 && others.length > 0) {
      const target = prompt(
        `${cardCount} card(s) live in "${lane.name}".\nReassign to which lane?\n\n${others.map((l, i) => `${i + 1}. ${l.name}`).join("\n")}\n\nEnter the number of the destination lane:`,
      );
      if (!target) return;
      const idx = Number(target) - 1;
      const dest = others[idx];
      if (!dest) { alert("Invalid selection."); return; }
      del.mutate({ id: lane.id, reassign_to: dest.id });
    } else {
      if (!confirm(`Delete "${lane.name}"? ${cardCount > 0 && others.length === 0 ? "Its cards will move to the Unassigned area." : ""}`)) return;
      del.mutate({ id: lane.id, reassign_to: null });
    }
  }

  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Swim lanes</h2>
      <p className="mt-1 text-xs text-wp-slate">Drag to reorder. Deleting a lane with cards will prompt to reassign them.</p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={(lanes.data ?? []).map((l) => l.id)} strategy={verticalListSortingStrategy}>
          <ul className="mt-3 divide-y divide-wp-stone">
            {lanes.data?.map((lane) => (
              <SortableLaneRow
                key={lane.id}
                lane={lane}
                onToggleTerminal={(v) => patch.mutate({ id: lane.id, body: { is_terminal: v } })}
                onToggleStatus={(v) => patch.mutate({ id: lane.id, body: { requires_weekly_status: v } })}
                onRename={(v) => patch.mutate({ id: lane.id, body: { name: v } })}
                onRecolor={(v) => patch.mutate({ id: lane.id, body: { color: v } })}
                onDescribe={(v) => patch.mutate({ id: lane.id, body: { description: v } })}
                onDelete={() => handleDelete(lane)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1 text-xs font-medium text-wp-slate">
          New lane name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Prototype" />
        </label>
        <label className="text-xs font-medium text-wp-slate">
          Color
          <input type="color" className="mt-1 h-8 w-16 cursor-pointer rounded border border-wp-stone" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add lane</button>
      </div>
    </section>
  );
}

function SortableLaneRow(props: {
  lane: SwimLane;
  onToggleTerminal: (v: boolean) => void;
  onToggleStatus: (v: boolean) => void;
  onRename: (v: string) => void;
  onRecolor: (v: string) => void;
  onDescribe: (v: string) => void;
  onDelete: () => void;
}) {
  const { lane, onToggleTerminal, onToggleStatus, onRename, onRecolor, onDescribe, onDelete } = props;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: lane.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className="py-3">
      <div className="flex items-center gap-3">
        <button {...attributes} {...listeners} className="btn-ghost !p-1" aria-label="Drag to reorder"><GripVertical size={14} /></button>
        <input
          type="color"
          className="h-7 w-10 cursor-pointer rounded border border-wp-stone"
          value={lane.color ?? "#94a3b8"}
          onChange={(e) => onRecolor(e.target.value)}
        />
        <input
          className="input flex-1"
          defaultValue={lane.name}
          onBlur={(e) => { if (e.target.value !== lane.name) onRename(e.target.value); }}
        />
        <label className="flex items-center gap-1 text-xs text-wp-slate">
          <input type="checkbox" checked={lane.requires_weekly_status} onChange={(e) => onToggleStatus(e.target.checked)} />
          weekly status
        </label>
        <label className="flex items-center gap-1 text-xs text-wp-slate">
          <input type="checkbox" checked={lane.is_terminal} onChange={(e) => onToggleTerminal(e.target.checked)} />
          terminal
        </label>
        <button className="btn-ghost !p-1 text-red-600" aria-label="Delete lane" onClick={onDelete}><Trash2 size={14} /></button>
      </div>
      <div className="mt-2 pl-14">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-wp-slate/70">
          Description
        </label>
        <textarea
          key={`desc-${lane.id}-${lane.updated_at}`}
          className="input mt-1 h-20 w-full resize-y text-sm"
          placeholder="What belongs in this lane? When does a card leave it?"
          defaultValue={lane.description}
          onBlur={(e) => { if (e.target.value !== lane.description) onDescribe(e.target.value); }}
        />
      </div>
    </li>
  );
}

function ProductAreasAdmin() {
  const areas = useProductAreas();
  const projects = useProjects();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");

  const create = useMutation({
    mutationFn: () => api<ProductArea>("/product-areas", { method: "POST", body: JSON.stringify({ name, color }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["productAreas"] }); setName(""); },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<ProductArea> }) => api<ProductArea>(`/product-areas/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["productAreas"] }),
  });
  const del = useMutation({
    mutationFn: (v: { id: string; reassign_to: string | null }) => api(`/product-areas/${v.id}`, { method: "DELETE", body: JSON.stringify({ reassign_to: v.reassign_to }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["productAreas"] }); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  async function handleDelete(area: ProductArea) {
    const count = (projects.data ?? []).filter((p) => p.product_area_id === area.id && !p.deleted_at).length;
    const others = (areas.data ?? []).filter((a) => a.id !== area.id);
    let reassign: string | null = null;
    if (count > 0 && others.length > 0) {
      const target = prompt(
        `${count} project(s) live in "${area.name}".\nReassign to which area (blank = Unassigned)?\n\n${others.map((a, i) => `${i + 1}. ${a.name}`).join("\n")}\n\nEnter the number, or leave blank:`,
      );
      if (target === null) return;
      if (target.trim()) {
        const idx = Number(target) - 1;
        const dest = others[idx];
        if (!dest) { alert("Invalid selection."); return; }
        reassign = dest.id;
      }
    } else if (!confirm(`Delete "${area.name}"?`)) {
      return;
    }
    del.mutate({ id: area.id, reassign_to: reassign });
  }

  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Product Areas</h2>
      <ul className="mt-3 divide-y divide-wp-stone">
        {areas.data?.map((a) => (
          <li key={a.id} className="flex items-center gap-3 py-2">
            <input
              type="color"
              className="h-7 w-10 cursor-pointer rounded border border-wp-stone"
              value={a.color}
              onChange={(e) => patch.mutate({ id: a.id, body: { color: e.target.value } })}
            />
            <input
              className="input flex-1"
              defaultValue={a.name}
              onBlur={(e) => { if (e.target.value !== a.name) patch.mutate({ id: a.id, body: { name: e.target.value } }); }}
            />
            <button className="btn-ghost !p-1 text-red-600" aria-label="Delete area" onClick={() => handleDelete(a)}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1 text-xs font-medium text-wp-slate">
          New area name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-wp-slate">
          Color
          <input type="color" className="mt-1 h-8 w-16 cursor-pointer rounded border border-wp-stone" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add area</button>
      </div>
    </section>
  );
}

function UsersAdmin() {
  const users = useUsers();
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (v: { id: string; role: User["role"] }) => api<User>(`/users/${v.id}/role`, { method: "PATCH", body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Users &amp; roles</h2>
      <ul className="mt-3 divide-y divide-wp-stone">
        {users.data?.map((u) => (
          <li key={u.id} className="flex items-center gap-3 py-2">
            <span
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
              style={{ background: u.color }}
            >
              {u.name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("")}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-wp-ink">{u.name}</div>
              <div className="text-xs text-wp-slate">{u.email}</div>
            </div>
            <select
              className="input w-32"
              value={u.role}
              onChange={(e) => patch.mutate({ id: u.id, role: e.target.value as User["role"] })}
            >
              <option value="admin">admin</option>
              <option value="owner">owner</option>
              <option value="viewer">viewer</option>
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}
