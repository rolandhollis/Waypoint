import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { useMe, useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import {
  effectiveDates,
  emptyPhaseDates,
  fillMissingPhaseDates,
  type PhaseDateFields,
} from "../lib/phaseDates";
import { computeOverloads, overloadsForProject } from "../lib/capacity";
import type { Project, ProjectType } from "../lib/types";
import { CapacityWarning } from "./CapacityWarning";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { PairedDates } from "./PairedDates";
import { ProjectPicker } from "./ProjectPicker";
import { TeamMultiSelect } from "./TeamMultiSelect";

/**
 * `defaultLaneId` is retained on the public API for now to keep the
 * board's "Add new item" wiring stable, but the dialog no longer
 * lets the user *pick* a lane — every new project lands in the
 * admin-designated default lane, with a small hint of where that is.
 */
export function NewProjectDialog({ defaultLaneId: _defaultLaneId, onClose }: { defaultLaneId: string | null; onClose: () => void }) {
  const me = useMe();
  const lanes = useSwimLanes();
  const users = useUsers();
  const teams = useTeams();
  const projects = useProjects();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(me.data?.id ?? null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // Default new items to "epic" — that's the common case (a top-level
  // initiative). Flipping to "subtask" reveals the parent picker.
  const [type, setType] = useState<ProjectType>("epic");
  const [parentId, setParentId] = useState<string | null>(null);
  // New items count toward capacity by default; PM can toggle this
  // off pre-create when they know the item is a placeholder or a
  // subtask whose load is already tracked on the parent.
  const [countsForCapacity, setCountsForCapacity] = useState(true);

  // Resolve the landing lane the same way the backend does, so the
  // "New items land in X" hint matches reality.
  const laneList = lanes.data ?? [];
  const resolvedLane =
    laneList.find((l) => l.is_default_new) ??
    laneList.filter((l) => !l.is_terminal).sort((a, b) => a.order - b.order)[0] ??
    laneList[0] ??
    null;
  // Phase dates are optional; users can skip entirely and add them
  // later from the detail panel. Draft only carries fields the user
  // explicitly touched — `fillMissingPhaseDates` at submit time
  // promotes visible-but-implicit defaults into the payload so the
  // backend's ordering validator is happy.
  const [dateDraft, setDateDraft] = useState<Partial<PhaseDateFields>>({});

  const merged: PhaseDateFields = { ...emptyPhaseDates, ...dateDraft };
  const eff = effectiveDates(merged);

  function setDate(key: keyof PhaseDateFields, value: string | null) {
    setDateDraft((d) => ({ ...d, [key]: value }));
  }

  const create = useMutation({
    mutationFn: () => {
      const dates = fillMissingPhaseDates(dateDraft, emptyPhaseDates);
      // Omit swim_lane_id entirely — the backend will pick the
      // default lane and 400 if the workspace has none configured.
      return api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: description.trim() || undefined,
          owner_id: ownerId,
          teams: teamIds,
          type,
          parent_id: type === "subtask" ? parentId : null,
          excluded_from_capacity: !countsForCapacity,
          ...dates,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  // Subtasks require a parent to submit. Epics don't.
  const canSubmit = !!title.trim() && !!resolvedLane
    && (type === "epic" || !!parentId)
    && !create.isPending;

  // Preview the capacity impact of this pending create. Build a fake
  // Project row that mirrors what the backend will insert so the
  // sweep sees the same entities, dates, and opt-out state the DB
  // row will hold on save. Uses effectiveDates so implicit-default
  // dates (which get filled in on submit) are treated as if they
  // were already persisted.
  const draftOverloads = useMemo(() => {
    const preview: Project = {
      id: "__draft__",
      title: title || "(new project)",
      description,
      swim_lane_id: resolvedLane?.id ?? null,
      position: 0,
      owner_id: ownerId,
      teams: teamIds,
      tags: [],
      kpis: [],
      // New project has no deadlines or dependencies yet; they're
      // added post-create via the project detail panel.
      deadlines: [],
      dependencies: [],
      type,
      parent_id: type === "subtask" ? parentId : null,
      start_date: merged.start_date,
      target_date: eff.target,
      dev_start_date: eff.devStart,
      dev_end_date: eff.devEnd,
      optimization_start_date: eff.optStart,
      optimization_end_date: eff.optEnd,
      actual_completion_date: null,
      excluded_from_capacity: !countsForCapacity,
      deleted_at: null,
      created_by: me.data?.id ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const all = computeOverloads(projects.data ?? [], users.data ?? [], teams.data ?? [], preview);
    return overloadsForProject(all, preview);
  }, [title, description, resolvedLane?.id, ownerId, teamIds, type, parentId, countsForCapacity, eff, merged.start_date, me.data?.id, projects.data, users.data, teams.data]);

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-wp-stone px-5 py-3">
            <Dialog.Title className="text-base font-semibold">New project</Dialog.Title>
            <button aria-label="Close" className="btn-ghost !p-1" onClick={onClose}><X size={18} /></button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            <label className="block text-xs font-medium text-wp-slate">Title
              <input className="input mt-1" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <fieldset className="block text-xs font-medium text-wp-slate">
              <legend className="mb-1">Type</legend>
              {/*
                Radio pair — epic vs subtask — with the parent picker
                revealed inline when subtask is chosen. Kept as native
                radios so keyboard nav (arrow keys / tab) works without
                extra JS.
              */}
              <div className="flex items-center gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-wp-ink">
                  <input
                    type="radio"
                    name="new-project-type"
                    value="epic"
                    checked={type === "epic"}
                    onChange={() => { setType("epic"); setParentId(null); }}
                  />
                  Epic <span className="text-xs text-wp-slate">(top-level)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-wp-ink">
                  <input
                    type="radio"
                    name="new-project-type"
                    value="subtask"
                    checked={type === "subtask"}
                    onChange={() => setType("subtask")}
                  />
                  Subtask <span className="text-xs text-wp-slate">(nested under a parent)</span>
                </label>
              </div>
              {type === "subtask" ? (
                <div className="mt-2">
                  <span className="mb-1 block text-xs font-medium text-wp-slate">
                    Parent <span className="text-wp-red">*</span>
                  </span>
                  <ProjectPicker
                    value={parentId}
                    onChange={setParentId}
                    projects={projects.data ?? []}
                  />
                  {!parentId ? (
                    <p className="mt-1 text-[11px] text-wp-slate/80">
                      Every subtask needs a parent — search by title above.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
            <label className="block text-xs font-medium text-wp-slate">
              Description <span className="text-wp-slate/70">(optional)</span>
              <textarea
                className="input mt-1 min-h-[5rem]"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project? Add context, links, or acceptance notes."
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 block text-xs font-medium text-wp-slate">Owner
                <select className="input mt-1" value={ownerId ?? ""} onChange={(e) => setOwnerId(e.target.value || null)}>
                  <option value="">— None —</option>
                  {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
              <label className="col-span-2 block text-xs font-medium text-wp-slate">
                Teams <span className="text-wp-slate/70">(one or more — a project can belong to multiple)</span>
                <div className="mt-1">
                  <TeamMultiSelect
                    teams={teams.data ?? []}
                    value={teamIds}
                    onChange={setTeamIds}
                  />
                </div>
              </label>
            </div>

            {resolvedLane ? (
              <p className="text-xs text-wp-slate">
                New items land in <span className="font-medium text-wp-ink">{resolvedLane.name}</span>. Admins can change this in Settings.
              </p>
            ) : (
              <p className="text-xs text-wp-red">
                No swim lanes exist yet. Ask an admin to create one before adding items.
              </p>
            )}

            <div className="border-t border-wp-stone/60 pt-3">
              <p className="text-xs text-wp-slate">
                Dates <span className="text-wp-slate/70">(optional — you can add them later)</span>
              </p>

              <div className="mt-2 space-y-3">
                <PhaseField label="Discovery and Definition">
                  <PairedDates
                    startLabel="Start"
                    startValue={merged.start_date}
                    onStartChange={(v) => setDate("start_date", v)}
                    endLabel="Ready for dev"
                    endValue={merged.target_date}
                    endMin={merged.start_date}
                    onEndChange={(v) => setDate("target_date", v)}
                  />
                </PhaseField>

                <PhaseField
                  label="Development"
                  hint={!eff.target ? "Set Discovery ‘Ready for dev’ first — Development picks up from there." : undefined}
                >
                  <PairedDates
                    startLabel="Start"
                    startValue={eff.devStart}
                    startMin={eff.target}
                    onStartChange={(v) => setDate("dev_start_date", v)}
                    endLabel="End"
                    endValue={eff.devEnd}
                    endMin={eff.devStart}
                    onEndChange={(v) => setDate("dev_end_date", v)}
                    disabled={!eff.target}
                  />
                </PhaseField>

                <PhaseField
                  label="Post-Dev Optimization"
                  hint={!eff.target ? "Set Discovery ‘Ready for dev’ first — Post-Dev cascades from there." : undefined}
                >
                  <PairedDates
                    startLabel="Start"
                    startValue={eff.optStart}
                    startMin={eff.devEnd}
                    onStartChange={(v) => setDate("optimization_start_date", v)}
                    endLabel="End"
                    endValue={eff.optEnd}
                    endMin={eff.optStart}
                    onEndChange={(v) => setDate("optimization_end_date", v)}
                    disabled={!eff.target}
                  />
                </PhaseField>
              </div>
            </div>

            <div className="border-t border-wp-stone/60 pt-3">
              <p className="text-xs font-medium text-wp-slate">Capacity planning</p>
              <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-sm text-wp-ink">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-wp-red"
                  checked={countsForCapacity}
                  onChange={(e) => setCountsForCapacity(e.target.checked)}
                />
                <span>
                  Count this item against owner &amp; team capacity
                  <span className="ml-1 text-xs text-wp-slate/80">
                    (uncheck for placeholders or subtasks tracked elsewhere)
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="border-t border-wp-stone bg-white px-5 py-3">
            <CapacityWarning
              intervals={draftOverloads}
              users={users.data ?? []}
              teams={teams.data ?? []}
              className="mb-2"
            />
            <MutationErrorBanner mutation={create} className="mb-2" />
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!canSubmit}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PhaseField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-wp-slate">{label}</span>
        {hint ? <span className="text-[11px] text-wp-slate/80">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
