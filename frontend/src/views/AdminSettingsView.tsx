import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useMe, useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import type { PhaseDateKey, Project, SwimLane, Team, User } from "../lib/types";
import { MutationErrorBanner } from "../components/MutationErrorBanner";

type TabKey = "lanes" | "teams" | "users" | "archived";

const TABS: { key: TabKey; label: string; render: () => JSX.Element }[] = [
  { key: "lanes",    label: "Swim lanes",     render: () => <SwimLanesAdmin /> },
  { key: "teams",    label: "Teams",          render: () => <TeamsAdmin /> },
  { key: "users",    label: "Users",          render: () => <UsersAdmin /> },
  { key: "archived", label: "Archived cards", render: () => <ArchivedProjectsAdmin /> },
];

export function AdminSettingsView() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  // ?tab= persists the active section across reloads and is deep-linkable
  // (e.g. Slack messages like "check /admin?tab=users"). Falls back to
  // the first tab whenever the URL contains an unknown value.
  const rawTab = params.get("tab") ?? "";
  const active: TabKey = (TABS.find((t) => t.key === rawTab)?.key ?? TABS[0]!.key);

  if (me.data?.role !== "admin") {
    return <div className="p-6 text-sm text-wp-slate">Admin access required.</div>;
  }

  function setActive(key: TabKey) {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    setParams(next, { replace: true });
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-xl font-semibold text-wp-ink">Admin Settings</h1>

      <div
        role="tablist"
        aria-label="Admin sections"
        className="mt-4 flex gap-1 border-b border-wp-stone"
      >
        {TABS.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`admin-panel-${t.key}`}
              id={`admin-tab-${t.key}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(t.key)}
              className={
                "-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-medium transition " +
                (isActive
                  ? "border-wp-red text-wp-ink"
                  : "border-transparent text-wp-slate hover:text-wp-ink")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`admin-panel-${active}`}
        aria-labelledby={`admin-tab-${active}`}
        className="mt-6"
      >
        {TABS.find((t) => t.key === active)!.render()}
      </div>
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
      <MutationErrorBanner mutation={restore} className="mt-3" />
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
      if (cardCount > 0 && others.length === 0) {
        alert(`"${lane.name}" is the only remaining swim lane and still holds ${cardCount} card(s). Create another lane and reassign these cards before deleting.`);
        return;
      }
      if (!confirm(`Delete "${lane.name}"?`)) return;
      del.mutate({ id: lane.id, reassign_to: null });
    }
  }

  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Swim lanes</h2>
      <p className="mt-1 text-xs text-wp-slate">Drag to reorder. Deleting a lane with cards will prompt to reassign them.</p>

      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={patch} className="mt-3" />
      <MutationErrorBanner mutation={reorder} className="mt-3" />
      <MutationErrorBanner mutation={del} className="mt-3" />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={(lanes.data ?? []).map((l) => l.id)} strategy={verticalListSortingStrategy}>
          <ul className="mt-3 divide-y divide-wp-stone">
            {lanes.data?.map((lane) => (
              <SortableLaneRow
                key={lane.id}
                lane={lane}
                onToggleTerminal={(v) => patch.mutate({ id: lane.id, body: { is_terminal: v } })}
                onToggleStatus={(v) => patch.mutate({ id: lane.id, body: { requires_weekly_status: v } })}
                onSetDefault={() => patch.mutate({ id: lane.id, body: { is_default_new: true } })}
                onSetPhaseDateKey={(v) => patch.mutate({ id: lane.id, body: { phase_date_key: v } })}
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
  onSetDefault: () => void;
  onSetPhaseDateKey: (v: PhaseDateKey | null) => void;
  onRename: (v: string) => void;
  onRecolor: (v: string) => void;
  onDescribe: (v: string) => void;
  onDelete: () => void;
}) {
  const { lane, onToggleTerminal, onToggleStatus, onSetDefault, onSetPhaseDateKey, onRename, onRecolor, onDescribe, onDelete } = props;
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
        <label
          className="flex items-center gap-1 text-xs text-wp-slate"
          title="New items created from the board land here."
        >
          {/* Radio semantics: promoting one lane demotes the previous default
              server-side (see swim-lanes PATCH). Clicking the currently-set
              lane is a no-op; unset by promoting a different lane instead. */}
          <input
            type="radio"
            name="swim-lane-default-new"
            checked={lane.is_default_new}
            onChange={() => { if (!lane.is_default_new) onSetDefault(); }}
          />
          default for new
        </label>
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
      <div className="mt-2 grid grid-cols-1 gap-3 pl-14 md:grid-cols-[2fr,1fr]">
        <div>
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
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-wp-slate/70">
            Prompt to update
          </label>
          <select
            className="input mt-1 w-full text-sm"
            value={lane.phase_date_key ?? ""}
            onChange={(e) => onSetPhaseDateKey((e.target.value || null) as PhaseDateKey | null)}
          >
            <option value="">— No prompt —</option>
            <option value="target_date">Ready-for-dev date</option>
            <option value="dev_start_date">Development start</option>
            <option value="dev_end_date">Development end</option>
            <option value="optimization_start_date">Post-dev start</option>
            <option value="optimization_end_date">Post-dev end</option>
          </select>
          <p className="mt-1 text-[11px] text-wp-slate/70">
            When set, dragging a card here asks the PM to stamp this date.
          </p>
        </div>
      </div>
    </li>
  );
}

function TeamsAdmin() {
  const teams = useTeams();
  const projects = useProjects();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");

  const create = useMutation({
    mutationFn: () => api<Team>("/teams", { method: "POST", body: JSON.stringify({ name, color }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["teams"] }); setName(""); },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<Team> }) => api<Team>(`/teams/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
  const del = useMutation({
    mutationFn: (v: { id: string; reassign_to: string | null }) => api(`/teams/${v.id}`, { method: "DELETE", body: JSON.stringify({ reassign_to: v.reassign_to }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["teams"] }); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  async function handleDelete(team: Team) {
    const count = (projects.data ?? []).filter((p) => p.teams.includes(team.id) && !p.deleted_at).length;
    const others = (teams.data ?? []).filter((t) => t.id !== team.id);
    let reassign: string | null = null;
    if (count > 0 && others.length > 0) {
      const target = prompt(
        `${count} project(s) belong to "${team.name}".\nReassign to which team (blank = drop the membership)?\n\n${others.map((t, i) => `${i + 1}. ${t.name}`).join("\n")}\n\nEnter the number, or leave blank:`,
      );
      if (target === null) return;
      if (target.trim()) {
        const idx = Number(target) - 1;
        const dest = others[idx];
        if (!dest) { alert("Invalid selection."); return; }
        reassign = dest.id;
      }
    } else if (!confirm(`Delete "${team.name}"?`)) {
      return;
    }
    del.mutate({ id: team.id, reassign_to: reassign });
  }

  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Teams</h2>
      <p className="mt-1 text-xs text-wp-slate">Cross-functional pods that own or contribute to a project. Projects can belong to more than one.</p>
      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={patch} className="mt-3" />
      <MutationErrorBanner mutation={del} className="mt-3" />
      <ul className="mt-3 divide-y divide-wp-stone">
        {teams.data?.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2">
            <input
              type="color"
              className="h-7 w-10 cursor-pointer rounded border border-wp-stone"
              value={t.color}
              onChange={(e) => patch.mutate({ id: t.id, body: { color: e.target.value } })}
            />
            <input
              className="input flex-1"
              defaultValue={t.name}
              onBlur={(e) => { if (e.target.value !== t.name) patch.mutate({ id: t.id, body: { name: e.target.value } }); }}
            />
            <button className="btn-ghost !p-1 text-red-600" aria-label="Delete team" onClick={() => handleDelete(t)}><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1 text-xs font-medium text-wp-slate">
          New team name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-wp-slate">
          Color
          <input type="color" className="mt-1 h-8 w-16 cursor-pointer rounded border border-wp-stone" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add team</button>
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
      <MutationErrorBanner mutation={patch} className="mt-3" />
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
