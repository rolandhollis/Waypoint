import { useMemo, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, Link2, Trash2, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCanWrite, useProjects, useSwimLanes } from "../lib/queries";
import { computeDependencyStatuses, type DependencyStatus } from "../lib/dependencies";
import type { Project, ProjectDependency, SwimLane } from "../lib/types";
import { ProjectPicker } from "./ProjectPicker";

/**
 * Dependencies section of the project detail panel.
 *
 * Read-only for viewers; owners/admins can add + delete. Only
 * swim lanes with a `phase_date_key` are pickable on either side
 * — the server rejects unbound lanes and the calculator has
 * nothing to compare against.
 *
 * The upstream project picker excludes the current project (no
 * self-deps allowed by CHECK constraint anyway) and archived /
 * deleted projects. It does NOT exclude projects that would form
 * cycles; cycles just render as violations on both sides, which
 * is the intended signal.
 */
export function ProjectDependencies({ project }: { project: Project }) {
  const lanes = useSwimLanes();
  const projects = useProjects();
  const canWrite = useCanWrite();
  const qc = useQueryClient();

  // At most one dep in "edit" mode at a time; same pattern as
  // deadlines above. Click a row to enter edit mode.
  const [editingId, setEditingId] = useState<string | null>(null);

  const lanesById = useMemo(
    () => new Map((lanes.data ?? []).map((l) => [l.id, l])),
    [lanes.data],
  );
  const projectsById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );

  const statuses = useMemo(
    () => computeDependencyStatuses(project, lanesById, projectsById),
    [project, lanesById, projectsById],
  );

  const eligibleLanes = (lanes.data ?? []).filter(
    (l) => l.phase_date_key && !l.is_admin_only,
  );

  const del = useMutation({
    mutationFn: (depId: string) =>
      api(`/projects/${project.id}/dependencies/${depId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", project.id] });
      setEditingId(null);
    },
  });

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-wp-ink">Dependencies</h3>
        <span className="text-xs text-wp-slate">
          This phase can&rsquo;t start until the upstream phase ends. Warns when a start date beats an end date.
        </span>
      </div>

      {statuses.length === 0 ? (
        <p className="mt-2 text-xs text-wp-slate">No dependencies set.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {statuses.map((s) =>
            editingId === s.dep.id && canWrite ? (
              <EditDependencyForm
                key={s.dep.id}
                projectId={project.id}
                currentProjectId={project.id}
                dep={s.dep}
                projects={projects.data ?? []}
                lanes={eligibleLanes}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <DependencyRow
                key={s.dep.id}
                status={s}
                canWrite={canWrite}
                onEdit={canWrite ? () => setEditingId(s.dep.id) : undefined}
                onDelete={() => {
                  if (confirm("Remove this dependency?")) del.mutate(s.dep.id);
                }}
              />
            ),
          )}
        </ul>
      )}

      {canWrite && eligibleLanes.length >= 1 ? (
        <AddDependencyForm
          projectId={project.id}
          currentProjectId={project.id}
          projects={projects.data ?? []}
          lanes={eligibleLanes}
        />
      ) : null}
    </section>
  );
}

function DependencyRow({
  status,
  canWrite,
  onEdit,
  onDelete,
}: {
  status: DependencyStatus;
  canWrite: boolean;
  /** Present iff the caller can write. Clicking the row body fires
   *  this. Left undefined for viewers so the row is inert. */
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const { dep, thisLane, otherProject, otherLane, thisStart, otherEnd, severity } = status;
  const violated = severity === "violated";
  const interactive = !!onEdit;

  const thisLaneName = thisLane?.name ?? "(deleted lane)";
  const otherProjectName = otherProject?.title ?? "(deleted project)";
  const otherLaneName = otherLane?.name ?? "(deleted lane)";
  const thisStartLabel = thisStart ? format(thisStart, "MMM d, yyyy") : "not scheduled";
  const otherEndLabel = otherEnd ? format(otherEnd, "MMM d, yyyy") : "not scheduled";

  const body = (
    <>
      <div className="font-medium">
        <span className="tabular-nums">{thisLaneName}</span> blocked by{" "}
        <span className="italic">{otherProjectName}</span>&rsquo;s{" "}
        <span className="tabular-nums">{otherLaneName}</span> end
      </div>
      <div className={"mt-0.5 text-[11px] " + (violated ? "text-red-700" : "text-wp-slate")}>
        This phase starts <span className="tabular-nums">{thisStartLabel}</span>
        {" · upstream ends "}
        <span className="tabular-nums">{otherEndLabel}</span>
      </div>
      {dep.note ? (
        <div className="mt-0.5 text-[11px] italic text-wp-slate">{dep.note}</div>
      ) : null}
    </>
  );

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
        <Link2 size={14} className="mt-0.5 shrink-0 text-wp-slate" />
      )}
      {interactive ? (
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 text-left"
          aria-label="Edit dependency"
        >
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{body}</div>
      )}
      {canWrite ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-red-600"
          aria-label="Remove dependency"
        >
          <Trash2 size={12} />
        </button>
      ) : null}
    </li>
  );
}

/**
 * Inline edit form for an existing dependency. Same layout as
 * AddDependencyForm so users see consistent controls. The Save
 * button only fires when at least one field has changed.
 */
function EditDependencyForm({
  projectId,
  currentProjectId,
  dep,
  projects,
  lanes,
  onDone,
}: {
  projectId: string;
  currentProjectId: string;
  dep: ProjectDependency;
  projects: Project[];
  lanes: SwimLane[];
  onDone: () => void;
}) {
  const [thisLaneId, setThisLaneId] = useState(dep.project_swim_lane_id);
  const [otherProjectId, setOtherProjectId] = useState<string | null>(dep.depends_on_project_id);
  const [otherLaneId, setOtherLaneId] = useState(dep.depends_on_swim_lane_id);
  const [note, setNote] = useState(dep.note);
  const qc = useQueryClient();

  const excludeIds = useMemo(() => new Set([currentProjectId]), [currentProjectId]);
  const upstreamCandidates = projects.filter((p) => !p.deleted_at);

  const save = useMutation({
    mutationFn: () =>
      api<ProjectDependency>(`/projects/${projectId}/dependencies/${dep.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_swim_lane_id: thisLaneId,
          depends_on_project_id: otherProjectId,
          depends_on_swim_lane_id: otherLaneId,
          note,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", projectId] });
      onDone();
    },
  });

  const dirty =
    thisLaneId !== dep.project_swim_lane_id ||
    otherProjectId !== dep.depends_on_project_id ||
    otherLaneId !== dep.depends_on_swim_lane_id ||
    note !== dep.note;
  const canSubmit = !!thisLaneId && !!otherProjectId && !!otherLaneId && !save.isPending && dirty;

  return (
    <li className="rounded-md border border-wp-red/60 bg-wp-stone/20 p-2.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) save.mutate();
        }}
        className="space-y-2"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[11px] text-wp-slate">
            <span className="mb-0.5">This item&rsquo;s phase</span>
            <select
              value={thisLaneId}
              onChange={(e) => setThisLaneId(e.target.value)}
              className="input h-9 w-auto min-w-[10rem]"
              autoFocus
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </label>
          <div className="flex-1 min-w-[16rem]">
            <div className="mb-0.5 text-[11px] text-wp-slate">Depends on item</div>
            <ProjectPicker
              value={otherProjectId}
              onChange={setOtherProjectId}
              projects={upstreamCandidates}
              excludeIds={excludeIds}
              placeholder="— Pick an item —"
              className="h-9"
            />
          </div>
          <label className="flex flex-col text-[11px] text-wp-slate">
            <span className="mb-0.5">&hellip; and that item&rsquo;s phase</span>
            <select
              value={otherLaneId}
              onChange={(e) => setOtherLaneId(e.target.value)}
              className="input h-9 w-auto min-w-[10rem]"
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
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
            <button type="submit" className="btn-primary text-xs" disabled={!canSubmit}>
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
        </div>
        {save.isError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
            {(save.error as Error).message}
          </div>
        ) : null}
      </form>
    </li>
  );
}

function AddDependencyForm({
  projectId,
  currentProjectId,
  projects,
  lanes,
}: {
  projectId: string;
  currentProjectId: string;
  projects: Project[];
  lanes: SwimLane[];
}) {
  const [thisLaneId, setThisLaneId] = useState<string>("");
  const [otherProjectId, setOtherProjectId] = useState<string | null>(null);
  const [otherLaneId, setOtherLaneId] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const qc = useQueryClient();

  const excludeIds = useMemo(() => new Set([currentProjectId]), [currentProjectId]);
  const upstreamCandidates = projects.filter((p) => !p.deleted_at);

  const create = useMutation({
    mutationFn: () =>
      api<ProjectDependency>(`/projects/${projectId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_swim_lane_id: thisLaneId,
          depends_on_project_id: otherProjectId,
          depends_on_swim_lane_id: otherLaneId,
          note,
        }),
      }),
    onSuccess: () => {
      setThisLaneId("");
      setOtherProjectId(null);
      setOtherLaneId("");
      setNote("");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", projectId] });
    },
  });

  const canSubmit = thisLaneId && otherProjectId && otherLaneId && !create.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) create.mutate();
      }}
      className="mt-3 space-y-2 rounded-md border border-wp-stone bg-wp-stone/20 p-2.5"
    >
      <div className="flex flex-wrap items-end gap-2">
        {/* All three controls share the shared `input` class + a
            fixed 2.25rem (h-9) height so they line up on the same
            baseline; ProjectPicker's trigger uses the same class. */}
        <label className="flex flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">This item&rsquo;s phase</span>
          <select
            value={thisLaneId}
            onChange={(e) => setThisLaneId(e.target.value)}
            className="input h-9 w-auto min-w-[10rem]"
          >
            <option value="">Select…</option>
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
        <div className="flex-1 min-w-[16rem]">
          <div className="mb-0.5 text-[11px] text-wp-slate">Depends on item</div>
          <ProjectPicker
            value={otherProjectId}
            onChange={setOtherProjectId}
            projects={upstreamCandidates}
            excludeIds={excludeIds}
            placeholder="— Pick an item —"
            className="h-9"
          />
        </div>
        <label className="flex flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">&hellip; and that item&rsquo;s phase</span>
          <select
            value={otherLaneId}
            onChange={(e) => setOtherLaneId(e.target.value)}
            className="input h-9 w-auto min-w-[10rem]"
          >
            <option value="">Select…</option>
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">Note (optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. shared library upgrade"
            className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
          />
        </label>
        <button type="submit" className="btn-secondary text-xs" disabled={!canSubmit}>
          {create.isPending ? "Adding…" : "Add dependency"}
        </button>
      </div>
      {create.isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {(create.error as Error).message}
        </div>
      ) : null}
    </form>
  );
}
