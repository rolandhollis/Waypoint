import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { AlertTriangle, Trash2, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCanWrite, useSwimLanes } from "../lib/queries";
import { computeDeadlineStatuses, type DeadlineStatus } from "../lib/deadlines";
import type { Project, ProjectDeadline } from "../lib/types";

/**
 * Deadlines section for the project detail panel.
 *
 * Read-only for viewers; owners/admins get the add form + delete
 * controls. Only swim lanes that currently have a phase_date_key
 * bound show up in the lane picker — a deadline on a lane without
 * a phase date has nothing to compare against, so the server
 * refuses to create it and the UI hides it upstream.
 *
 * Existing deadlines whose lane later loses its phase binding
 * are STILL displayed (with severity="ok" and a small "no phase
 * bound" note) so the PM can either restore the binding or delete
 * the deadline explicitly, rather than have it silently vanish.
 */
export function ProjectDeadlines({ project }: { project: Project }) {
  const lanes = useSwimLanes();
  const canWrite = useCanWrite();
  const qc = useQueryClient();

  // At most one row can be in "edit" mode at a time. Click a row to
  // enter edit mode; Save / Cancel / clicking another row exits.
  const [editingId, setEditingId] = useState<string | null>(null);

  const lanesById = useMemo(
    () => new Map((lanes.data ?? []).map((l) => [l.id, l])),
    [lanes.data],
  );

  const statuses = useMemo(
    () => computeDeadlineStatuses(project, lanesById),
    [project, lanesById],
  );

  const usedLaneIds = new Set(project.deadlines.map((d) => d.swim_lane_id));
  // Lane must have a phase_date_key AND not already carry a
  // deadline on this project. Also skip admin-only lanes because
  // owners can't see them anyway.
  const eligibleLanes = (lanes.data ?? []).filter(
    (l) => l.phase_date_key && !l.is_admin_only && !usedLaneIds.has(l.id),
  );

  const del = useMutation({
    mutationFn: (deadlineId: string) =>
      api(`/projects/${project.id}/deadlines/${deadlineId}`, { method: "DELETE" }),
    onSuccess: () => {
      // The detail panel reads project via useQuery(["project", id]),
      // not the list; both need invalidating so the deadlines section
      // updates immediately AND the roadmap tick marks stay in sync
      // when the panel is closed.
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", project.id] });
      setEditingId(null);
    },
  });

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-wp-ink">Deadlines</h3>
        <span className="text-xs text-wp-slate">
          One per swim lane. Warns when the phase runs past the promised date.
        </span>
      </div>

      {statuses.length === 0 ? (
        <p className="mt-2 text-xs text-wp-slate">No deadlines set.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {statuses.map((s) =>
            editingId === s.deadline.id && canWrite ? (
              <EditDeadlineForm
                key={s.deadline.id}
                projectId={project.id}
                status={s}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <DeadlineRow
                key={s.deadline.id}
                status={s}
                canWrite={canWrite}
                onEdit={canWrite ? () => setEditingId(s.deadline.id) : undefined}
                onDelete={() => {
                  if (confirm(`Remove the ${s.lane?.name ?? "deadline"} deadline?`)) {
                    del.mutate(s.deadline.id);
                  }
                }}
              />
            ),
          )}
        </ul>
      )}

      {canWrite && eligibleLanes.length > 0 ? (
        <AddDeadlineForm
          projectId={project.id}
          laneOptions={eligibleLanes.map((l) => ({ id: l.id, name: l.name, phaseKey: l.phase_date_key! }))}
        />
      ) : null}
      {canWrite && eligibleLanes.length === 0 && statuses.length === 0 ? (
        <p className="mt-2 rounded-md border border-wp-stone bg-wp-stone/20 px-3 py-2 text-xs text-wp-slate">
          No swim lanes with a phase-date binding are available. Ask an admin to
          set a phase key on a lane in Admin → Swim lanes to enable deadlines.
        </p>
      ) : null}
    </section>
  );
}

function DeadlineRow({
  status,
  canWrite,
  onEdit,
  onDelete,
}: {
  status: DeadlineStatus;
  canWrite: boolean;
  /** Present iff the caller can write. Clicking the row body fires
   *  this. Left undefined for viewers so the row is inert. */
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const { deadline, lane, phaseKey, phaseDate, severity } = status;
  const laneName = lane?.name ?? "(deleted lane)";
  const dl = format(parseISO(deadline.deadline_date), "MMM d, yyyy");
  const cur = phaseDate ? format(parseISO(phaseDate), "MMM d, yyyy") : "not scheduled";

  const violated = severity !== "ok";
  const interactive = !!onEdit;
  return (
    <li
      className={
        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs " +
        (violated
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-wp-stone bg-white text-wp-ink") +
        (interactive ? " hover:border-wp-red/40 hover:bg-wp-stone/20" : "")
      }
    >
      {violated ? (
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-600" />
      ) : (
        <span className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full bg-emerald-500/80" aria-hidden />
      )}
      {/* Body is a button when editable so keyboard users get a
          proper affordance. Viewers still see the same layout but
          without the button semantics. */}
      {interactive ? (
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left"
          aria-label={`Edit ${laneName} deadline`}
        >
          <DeadlineRowBody laneName={laneName} dl={dl} phaseKey={phaseKey} cur={cur} note={deadline.note} violated={violated} />
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <DeadlineRowBody laneName={laneName} dl={dl} phaseKey={phaseKey} cur={cur} note={deadline.note} violated={violated} />
        </div>
      )}
      {canWrite ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-red-600"
          aria-label="Remove deadline"
        >
          <Trash2 size={12} />
        </button>
      ) : null}
    </li>
  );
}

function DeadlineRowBody({
  laneName,
  dl,
  phaseKey,
  cur,
  note,
  violated,
}: {
  laneName: string;
  dl: string;
  phaseKey: string | null;
  cur: string;
  note: string;
  violated: boolean;
}) {
  return (
    <>
      <div className="font-medium">
        {laneName} by <span className="tabular-nums">{dl}</span>
      </div>
      <div className={"mt-0.5 text-[11px] " + (violated ? "text-red-700" : "text-wp-slate")}>
        {phaseKey
          ? <>Current {humanPhaseKey(phaseKey)}: <span className="tabular-nums">{cur}</span></>
          : "This lane no longer has a phase-date binding — deadline can't be enforced."}
      </div>
      {note ? (
        <div className="mt-0.5 text-[11px] italic text-wp-slate">{note}</div>
      ) : null}
    </>
  );
}

/**
 * Inline edit form that replaces a DeadlineRow when the row is
 * clicked. Layout mirrors the AddDeadlineForm below so users get
 * consistent controls.
 */
function EditDeadlineForm({
  projectId,
  status,
  onDone,
}: {
  projectId: string;
  status: DeadlineStatus;
  onDone: () => void;
}) {
  const { deadline, lane } = status;
  const [date, setDate] = useState(deadline.deadline_date);
  const [note, setNote] = useState(deadline.note);
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: () =>
      api<ProjectDeadline>(`/projects/${projectId}/deadlines/${deadline.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deadline_date: date, note }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", projectId] });
      onDone();
    },
  });

  const dirty = date !== deadline.deadline_date || note !== deadline.note;

  return (
    <li className="rounded-md border border-wp-red/60 bg-wp-stone/20 p-2.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !save.isPending) save.mutate();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">Swim lane</span>
          <div className="rounded-md border border-wp-stone bg-wp-stone/40 px-2 py-1 text-xs text-wp-ink">
            {lane?.name ?? "(deleted lane)"}
          </div>
        </div>
        <label className="flex flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">Deadline</span>
          <input
            type="date"
            autoFocus
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
          />
        </label>
        <label className="flex flex-1 flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">Note (optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
          />
        </label>
        <div className="flex items-center gap-1">
          <button
            type="submit"
            className="btn-primary text-xs"
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={onDone}
            disabled={save.isPending}
          >
            <X size={12} />
            Cancel
          </button>
        </div>
        {save.isError ? (
          <div className="basis-full rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
            {(save.error as Error).message}
          </div>
        ) : null}
      </form>
    </li>
  );
}

function AddDeadlineForm({
  projectId,
  laneOptions,
}: {
  projectId: string;
  laneOptions: { id: string; name: string; phaseKey: string }[];
}) {
  const [laneId, setLaneId] = useState<string>("");
  const [date, setDate] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api<ProjectDeadline>(`/projects/${projectId}/deadlines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swim_lane_id: laneId, deadline_date: date, note }),
      }),
    onSuccess: () => {
      setLaneId("");
      setDate("");
      setNote("");
      // Same story as the delete mutation above — detail panel is
      // backed by the per-project query, not the list, so it needs
      // its own invalidation to show the new row without a reload.
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", projectId] });
    },
  });

  const canSubmit = laneId && date && !create.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) create.mutate();
      }}
      className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-wp-stone bg-wp-stone/20 p-2.5"
    >
      <label className="flex flex-col text-[11px] text-wp-slate">
        <span className="mb-0.5">Swim lane</span>
        <select
          value={laneId}
          onChange={(e) => setLaneId(e.target.value)}
          className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
        >
          <option value="">Select…</option>
          {laneOptions.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-[11px] text-wp-slate">
        <span className="mb-0.5">Deadline</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
        />
      </label>
      <label className="flex flex-1 flex-col text-[11px] text-wp-slate">
        <span className="mb-0.5">Note (optional)</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Board review, vendor contract"
          className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
        />
      </label>
      <button type="submit" className="btn-secondary text-xs" disabled={!canSubmit}>
        {create.isPending ? "Adding…" : "Add deadline"}
      </button>
      {create.isError ? (
        <div className="basis-full rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {(create.error as Error).message}
        </div>
      ) : null}
    </form>
  );
}

function humanPhaseKey(k: string): string {
  const map: Record<string, string> = {
    target_date: "target date",
    dev_start_date: "dev start",
    dev_end_date: "dev end",
    optimization_start_date: "post-dev start",
    optimization_end_date: "post-dev end",
  };
  return map[k] ?? k;
}
