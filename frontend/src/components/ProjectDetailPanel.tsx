import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Lock, LockOpen, X } from "lucide-react";
import { api } from "../lib/api";
import type { Project, ProjectTimelineEntry, ProjectType, Team, WeeklyStatusUpdate } from "../lib/types";
import { AuditEventBody, auditActorLabel, timelineEntryToRenderEntry } from "../lib/auditRender";
import { useCanWrite, useCurrentGroupRole, useKpis, useMe, useProjectHistory, useProjects, useProjectStatusUpdates, useSwimLanes, useTeams, useTshirtSizes, useUsers } from "../lib/queries";
import { computePhases } from "../lib/phaseCompute";
import { effectiveDates, fillMissingPhaseDates } from "../lib/phaseDates";
import { ancestors, childrenByParent, descendants, indexById } from "../lib/hierarchy";
import { makeAiEstimateHandlers, type AiEstimatePatchArgs } from "../lib/aiEstimateApply";
import { AiSuggestPopover } from "./AiSuggestPopover";
import { CapacityWarning } from "./CapacityWarning";
import { computeOverloads, overloadsForProject } from "../lib/capacity";
import { KpiPicker } from "./KpiPicker";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { PairedDates } from "./PairedDates";
import { ProjectComments } from "./ProjectComments";
import { ProjectDeadlines } from "./ProjectDeadlines";
import { ProjectDependencies } from "./ProjectDependencies";
import { ProjectLinks } from "./ProjectLinks";
import { ProjectPicker } from "./ProjectPicker";
import { StatusPill } from "./StatusPill";
import { StatusUpdateForm } from "./StatusUpdateForm";
import { TagPicker } from "./TagPicker";
import { TeamMultiSelect } from "./TeamMultiSelect";

type Draft = Partial<Project>;

/**
 * Map from a persisted phase-date field name to its provenance
 * "phase key" — the backend uses these keys inside `_meta.editedPhases`
 * to distinguish direct edits from cascaded shifts. Kept in one
 * place so the touched-fields tracker below can compute the edited
 * phase set with one lookup.
 */
const PHASE_FIELD_TO_KEY: Record<string, "discovery" | "development" | "post_dev"> = {
  start_date: "discovery",
  target_date: "discovery",
  dev_start_date: "development",
  dev_end_date: "development",
  optimization_start_date: "post_dev",
  optimization_end_date: "post_dev",
};

/**
 * Set of persisted phase-date field names — used by the save handler
 * to distinguish phase-date edits (which need `_meta` provenance)
 * from ordinary field edits.
 */
const PHASE_DATE_FIELD_NAMES = Object.keys(PHASE_FIELD_TO_KEY) as ReadonlyArray<keyof Project>;

export function ProjectDetailPanel({
  id,
  onClose,
  onOpenProject,
  siblingIds,
}: {
  id: string;
  onClose: () => void;
  /**
   * Optional handler the parent view passes so breadcrumb / children
   * clicks can swap the currently-selected project without closing the
   * panel. Views that don't supply it fall back to a plain close.
   */
  onOpenProject?: (nextId: string) => void;
  /**
   * Optional ordered list of the surrounding items the user is
   * browsing (Board lane+position, Roadmap chart order, KPI section
   * order, etc.). When present the header renders prev/next chevrons
   * and the arrow keys wire up so the user can walk the list without
   * closing the panel back to the parent view. The current id must
   * appear in the list; if it doesn't (stale filter change, deletion,
   * etc.) nav collapses gracefully to disabled controls.
   */
  siblingIds?: string[];
}) {
  const me = useMe();
  // Write / role checks go through the per-group hooks so a user
  // who's owner in RMN but viewer in VC sees the read-only version
  // of the panel while browsing VC's cards, and vice versa.
  const canWrite = useCanWrite();
  const currentRole = useCurrentGroupRole();
  const lanes = useSwimLanes();
  const users = useUsers();
  const teams = useTeams();
  const kpis = useKpis();
  const tshirtSizes = useTshirtSizes();
  const allProjects = useProjects();
  const qc = useQueryClient();

  // Union of every tag currently used across the workspace — powers the
  // TagPicker's suggestion list so PMs pick from existing labels rather
  // than accidentally creating "ui", "UI", and "u.i" variants.
  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of allProjects.data ?? []) for (const t of p.tags) set.add(t);
    return Array.from(set);
  }, [allProjects.data]);

  const projectQuery = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<Project>(`/projects/${id}`),
  });
  const history = useProjectHistory(id);
  const statusUpdates = useProjectStatusUpdates(id);

  const [draft, setDraft] = useState<Draft>({});
  /**
   * Which phase-date FIELDS the user has directly touched since load.
   * We derive the `_meta.editedPhases` set from these on save so a
   * date change that was clearly a downstream cascade-clear (see
   * `cascadeClear` below) doesn't get mis-attributed as a direct
   * edit. Reset when the panel switches to a different project.
   */
  const [touchedPhaseFields, setTouchedPhaseFields] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setDraft({});
    setTouchedPhaseFields(new Set());
  }, [id]);

  const patch = useMutation({
    mutationFn: (body: Draft & { _meta?: { source: "user"; editedPhases: readonly ("discovery" | "development" | "post_dev")[] } }) =>
      api<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      qc.setQueryData(["project", id], updated);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectStatusUpdates", id] });
      qc.invalidateQueries({ queryKey: ["projectHistory", id] });
      setDraft({});
      setTouchedPhaseFields(new Set());
      onClose();
    },
  });

  /**
   * Sibling mutation used by the ✨ Suggest popover. Same endpoint,
   * but distinct from the manual Save mutation above because:
   *
   *   - It must NOT close the panel (`onClose`) — the user is still
   *     editing.
   *   - It must NOT wipe unrelated draft edits (title, tags,
   *     description, …). Only the phase-date entries the fresh
   *     PATCH just persisted are cleared so the merged view echoes
   *     the AI's new dates instead of a stale user-typed draft.
   *   - It shares the SAME cache-invalidation set as the manual
   *     save (`["project", id]` + `["projects"]` + history) so the
   *     date pickers immediately reflect the new values.
   *
   * `_meta.source` is stamped by `makeAiEstimateHandlers` — we don't
   * override it here.
   */
  const aiPatch = useMutation({
    mutationFn: (args: AiEstimatePatchArgs) =>
      api<Project>(`/projects/${args.projectId}`, {
        method: "PATCH",
        body: JSON.stringify(args.body),
      }),
    onSuccess: (updated, args) => {
      qc.setQueryData(["project", id], updated);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", id] });
      // Clear any user-typed drafts for the phase-date fields the AI
      // just wrote so the merged view picks up the fresh dates. Non-
      // phase draft entries (title, tags, description, …) survive so
      // the user's in-flight edits don't get discarded.
      setDraft((prev) => {
        const next: Draft = { ...prev };
        for (const key of Object.keys(args.body)) {
          if (key === "_meta") continue;
          if (PHASE_DATE_FIELD_NAMES.includes(key as keyof Project)) {
            delete (next as Record<string, unknown>)[key];
          }
        }
        return next;
      });
      setTouchedPhaseFields((prev) => {
        // Untouch every phase-date field — either the AI wrote a new
        // value (so the field isn't "user-touched" anymore) OR the
        // field was untouched to begin with (no-op). We could scope
        // to phase-key granularity but the panel's `_meta` derivation
        // is coarse enough that a full clear is byte-equivalent.
        if (prev.size === 0) return prev;
        return new Set();
      });
    },
  });

  const archive = useMutation({
    mutationFn: () => api<Project>(`/projects/${id}/archive`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", id] });
      qc.invalidateQueries({ queryKey: ["pendingStatus"] });
      onClose();
    },
  });

  /**
   * Persistent per-project auto-scheduler lock toggle. Distinct from
   * the manual Save mutation above because:
   *   - It fires immediately (no draft staging) — the padlock is a
   *     one-click affordance in the header, not a form field.
   *   - It must NOT close the panel — flipping the lock is often a
   *     precursor to further edits.
   *   - It carries `_meta.source: 'user'` so the backend's per-phase
   *     provenance stamper stays consistent (though `dates_locked`
   *     isn't a phase field, `_meta` on unrelated PATCHes is
   *     safely ignored by the stamper).
   * The dedicated invalidate on `["project", id]` + `["projects"]`
   * refreshes both the header state and every list-view that reads
   * `dates_locked` (Roadmap Gantt padlock glyph, Auto-schedule
   * picker).
   */
  const lockToggle = useMutation({
    mutationFn: (nextLocked: boolean) =>
      api<Project>(`/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          dates_locked: nextLocked,
          _meta: { source: "user" as const },
        }),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(["project", id], updated);
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectHistory", id] });
    },
  });

  // IMPORTANT: every hook below runs on *every* render, even before
  // the project fetch resolves, so the hook order stays stable across
  // the loading → loaded transition. React error #310 fires the moment
  // an early return skips downstream hooks; adding useKpis above
  // shifted the count and started tripping it deterministically.
  //
  // Convention: `maybeProject` / `maybeMerged` are nullable and used
  // only in the hooks below. After the null-check we shadow them with
  // the plain `project` / `merged` names so all downstream JSX stays
  // ergonomic (Project, not Project|null).
  const maybeProject = projectQuery.data ?? null;
  const maybeMerged: Project | null = maybeProject
    ? ({ ...maybeProject, ...draft } as Project)
    : null;

  const projectList = allProjects.data ?? [];
  const byId = useMemo(() => indexById(projectList), [projectList]);
  const kids = useMemo(() => childrenByParent(projectList), [projectList]);
  const parentChain = useMemo(
    () => (maybeMerged ? ancestors(maybeMerged.id, byId).reverse() : []),
    [maybeMerged?.id, byId],
  );
  const excludeParentIds = useMemo(() => {
    const s = new Set<string>();
    if (!maybeMerged) return s;
    s.add(maybeMerged.id);
    for (const d of descendants(maybeMerged.id, kids)) s.add(d.id);
    return s;
  }, [maybeMerged?.id, kids]);

  // Capacity check runs on every draft edit — cheap enough (~sub-ms
  // even with 100 projects) that we don't debounce. Feeds the inline
  // CapacityWarning below the form.
  const draftOverloads = useMemo(() => {
    if (!maybeMerged) return [];
    const all = computeOverloads(projectList, users.data ?? [], teams.data ?? [], maybeMerged);
    return overloadsForProject(all, maybeMerged);
  }, [maybeMerged, projectList, users.data, teams.data]);

  // Prev/next neighbours from the surrounding view's sibling list.
  // We look at the *current* id (not the merged draft) because the
  // sibling list is keyed off what the parent view is showing, which
  // never reflects unsaved edits. If the current id isn't in the
  // list (deletion, filter change) both neighbours are null and the
  // controls disable — the user can still close and pick a new one.
  const siblingNav = useMemo(() => {
    if (!siblingIds || !onOpenProject) return { prev: null, next: null, pos: 0, total: 0 };
    const idx = siblingIds.indexOf(id);
    if (idx === -1) return { prev: null, next: null, pos: 0, total: siblingIds.length };
    return {
      prev: idx > 0 ? siblingIds[idx - 1]! : null,
      next: idx < siblingIds.length - 1 ? siblingIds[idx + 1]! : null,
      pos: idx + 1,
      total: siblingIds.length,
    };
  }, [siblingIds, id, onOpenProject]);

  // Arrow-key navigation across siblings. Bound to the window (not
  // the panel root) so the shortcut works no matter where focus is
  // inside the modal — as long as focus isn't inside a text input or
  // contenteditable, where the arrow keys legitimately move the
  // caret. We deliberately don't fight Radix's own Escape handling.
  useEffect(() => {
    if (!onOpenProject) return;
    const open = onOpenProject;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      // Skip when focus is somewhere the arrow keys mean "move the
      // caret" — text inputs, textareas, selects, contenteditable
      // surfaces. This avoids hijacking the user's edit gesture.
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      if (e.key === "ArrowLeft" && siblingNav.prev) {
        e.preventDefault();
        open(siblingNav.prev);
      } else if (e.key === "ArrowRight" && siblingNav.next) {
        e.preventDefault();
        open(siblingNav.next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenProject, siblingNav.prev, siblingNav.next]);

  // Neighbour titles for tooltip copy — a small "next: XYZ" hint on
  // hover is worth the two extra map lookups.
  const prevTitle = siblingNav.prev ? byId.get(siblingNav.prev)?.title : null;
  const nextTitle = siblingNav.next ? byId.get(siblingNav.next)?.title : null;

  if (!maybeProject || !maybeMerged) return null;
  const project: Project = maybeProject;
  const merged: Project = maybeMerged;

  const phases = computePhases(merged);
  const eff = effectiveDates(merged);
  const owner = users.data?.find((u) => u.id === merged.owner_id);
  // Header chip preview follows the same team ranking as every other
  // renderer: iterate `merged.teams` (the ordered list) and hydrate
  // via the catalog map so the primary team always leads.
  const teamsById = new Map((teams.data ?? []).map((t) => [t.id, t] as const));
  const projectTeams = merged.teams
    .map((id) => teamsById.get(id))
    .filter((t): t is Team => !!t);
  const lane = lanes.data?.find((l) => l.id === merged.swim_lane_id);
  const requiresStatus = !!lane?.requires_weekly_status;
  const myChildren = kids.get(merged.id) ?? [];
  // Show the archive button whenever the card isn't already in an
  // archive lane. Non-admins never see admin-only lanes in
  // `lanes.data`, so `lane.is_archive` is always false for them and
  // the button appears; the backend resolves the destination lane's
  // id from the archive flag on the server side.
  const inArchive = !!lane?.is_archive;
  const canArchive = canWrite && !inArchive;

  /**
   * AI ✨ Suggest handlers, bound to the currently-viewed project.
   * Same PATCH pipeline EZEstimates uses (`_meta.source: 'claude'`,
   * per-phase edit list, atomic Accept-All body) — factored through
   * `makeAiEstimateHandlers` so any drift in the cascade math flows
   * through one place. The popover component itself owns open/close
   * state, so we don't have to thread anything but the two accept
   * callbacks through here.
   */
  const aiHandlers = makeAiEstimateHandlers({
    project,
    patchProject: aiPatch,
    source: "claude",
  });

  /**
   * Wrap a phase-date input change: applies the value (running the
   * existing cascade-clear helper so downstream stale dates get
   * nulled), and records THIS specific field as user-touched. The
   * touched-fields set is what powers `_meta.editedPhases` on save —
   * any phase whose start OR end was directly typed by the user
   * becomes a direct-edit stamp; cascaded date shifts land as
   * source='cascade' on the backend.
   */
  const markPhaseDateChange = (field: string, value: string | null) => {
    setTouchedPhaseFields((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
    setDraft((d) => cascadeClear({ ...d, [field]: value } as Draft, project));
  };

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-white shadow-xl outline-none">
          <div className="flex items-start justify-between border-b border-wp-stone px-5 py-3">
            <div className="min-w-0 flex-1">
              {/* Type + parent breadcrumb above the title so hierarchy
                  context is the first thing a viewer registers. Clicking
                  a crumb navigates to that ancestor's detail panel. */}
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-wp-slate">
                <TypeBadge type={merged.type} />
                {parentChain.length ? (
                  <>
                    {parentChain.map((a, i) => (
                      <span key={a.id} className="flex items-center gap-1">
                        <button
                          className="max-w-[16rem] truncate text-left text-wp-slate hover:text-wp-ink hover:underline"
                          onClick={() => onOpenProject ? onOpenProject(a.id) : onClose()}
                          title={onOpenProject ? `Open ${a.title}` : "Close and navigate to the parent from the board"}
                        >
                          {a.title}
                        </button>
                        {i < parentChain.length - 1 ? <ChevronRight size={12} /> : null}
                      </span>
                    ))}
                    <ChevronRight size={12} />
                  </>
                ) : null}
              </div>
              <Dialog.Title asChild>
                <input
                  className="input !border-transparent !bg-transparent !p-0 text-lg font-semibold focus:!border-wp-red focus:!bg-white focus:!px-2"
                  value={merged.title}
                  disabled={!canWrite}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                />
              </Dialog.Title>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-wp-slate">
                {lane ? <span>Lane: <span className="text-wp-ink">{lane.name}</span></span> : null}
                {owner ? <span>Owner: <span className="text-wp-ink">{owner.name}</span></span> : null}
                {projectTeams.length ? (
                  <span>
                    Teams:{" "}
                    <span className="text-wp-ink">{projectTeams.map((t) => t.name).join(", ")}</span>
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              {/* Prev/next through the surrounding view's items.
                  Rendered only when the parent view supplied a
                  sibling list — Board / Roadmap / Status Report /
                  KPIs — so a modal opened out of context (nothing
                  meaningful to page through) stays uncluttered.
                  Arrow keys also navigate; see the effect above. */}
              {siblingIds && onOpenProject ? (
                <>
                  <button
                    type="button"
                    aria-label="Previous item"
                    className="btn-ghost !p-1 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => siblingNav.prev && onOpenProject(siblingNav.prev)}
                    disabled={!siblingNav.prev}
                    title={siblingNav.prev ? `Previous: ${prevTitle ?? ""} (\u2190)` : "No previous item"}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  {siblingNav.total > 0 && siblingNav.pos > 0 ? (
                    <span className="px-1 text-[11px] tabular-nums text-wp-slate">
                      {siblingNav.pos} / {siblingNav.total}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Next item"
                    className="btn-ghost !p-1 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => siblingNav.next && onOpenProject(siblingNav.next)}
                    disabled={!siblingNav.next}
                    title={siblingNav.next ? `Next: ${nextTitle ?? ""} (\u2192)` : "No next item"}
                  >
                    <ChevronRight size={18} />
                  </button>
                  <div className="mx-1 h-5 w-px bg-wp-stone" aria-hidden />
                </>
              ) : null}
              {/* The dates-lock toggle used to live here in the header,
                  but was moved down beside the "Timelines and Estimates"
                  section heading so the control sits with the fields it
                  governs. See that section below for the interactive
                  padlock and the viewer-read-only indicator. */}
              <button aria-label="Close" className="btn-ghost !p-1" onClick={onClose}>
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <Field label="Description" className="mb-3">
              <textarea
                className="input min-h-[8rem]"
                disabled={!canWrite}
                value={merged.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Owner">
                <select className="input" disabled={!canWrite} value={merged.owner_id ?? ""} onChange={(e) => setDraft((d) => ({ ...d, owner_id: e.target.value || null }))}>
                  <option value="">— Unassigned —</option>
                  {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field
                label="Teams"
                hint={merged.teams.length > 1
                  ? "Drag chips to reorder — first chip is the primary team, then secondary, and so on."
                  : undefined}
              >
                <TeamMultiSelect
                  teams={teams.data ?? []}
                  value={merged.teams}
                  onChange={(next) => setDraft((d) => ({ ...d, teams: next }))}
                  disabled={!canWrite}
                />
              </Field>
              <Field label="Tags">
                <TagPicker
                  value={merged.tags}
                  onChange={(next) => setDraft((d) => ({ ...d, tags: next }))}
                  suggestions={knownTags}
                  disabled={!canWrite}
                />
              </Field>
              <Field
                label="KPIs"
                className="col-span-2"
                hint={(merged.kpis?.length ?? 0) > 1
                  ? "Drag chips to reorder — first chip is the primary KPI, then secondary, and so on."
                  : undefined}
              >
                <KpiPicker
                  value={merged.kpis ?? []}
                  onChange={(next) => setDraft((d) => ({ ...d, kpis: next }))}
                  kpis={kpis.data ?? []}
                  disabled={!canWrite}
                />
              </Field>
              <Field
                label="Hierarchy"
                className="col-span-2"
                hint={merged.type === "subtask"
                  ? "Extending an end date here also extends its parent (and its ancestors) automatically."
                  : "Subtasks live under this epic. Shrinking an end date is rejected when a subtask still needs the room."}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-4">
                    {(["epic", "subtask"] as ProjectType[]).map((t) => (
                      <label key={t} className="flex cursor-pointer items-center gap-2 text-sm text-wp-ink">
                        <input
                          type="radio"
                          name={`project-type-${id}`}
                          value={t}
                          disabled={!canWrite}
                          checked={merged.type === t}
                          onChange={() => setDraft((d) => ({
                            ...d,
                            type: t,
                            // Flipping to epic clears the parent; flipping
                            // to subtask keeps whatever parent is currently
                            // set (or leaves it null for the picker to fill).
                            parent_id: t === "epic" ? null : d.parent_id ?? project.parent_id,
                          }))}
                        />
                        <span className="capitalize">{t}</span>
                      </label>
                    ))}
                  </div>
                  {merged.type === "subtask" ? (
                    <div className="min-w-0 flex-1">
                      <ProjectPicker
                        value={merged.parent_id}
                        onChange={(next) => setDraft((d) => ({ ...d, parent_id: next }))}
                        projects={projectList}
                        excludeIds={excludeParentIds}
                        disabled={!canWrite}
                        placeholder="— Pick a parent —"
                      />
                    </div>
                  ) : null}
                </div>
              </Field>
              {/* Timelines & Estimates ledger row — labels the three
                  phase-date fields below and hosts two controls:
                    • the persistent auto-scheduler lock padlock
                      (writers only; viewers see a read-only icon
                      reflecting the current state) — this is the
                      one authoritative UI for `dates_locked`,
                      colocated with the dates it governs.
                    • the ✨ Suggest popover, which pulls a Claude
                      suggestion for all three phases and, on
                      Accept / Accept-all, dispatches an IMMEDIATE
                      PATCH (Option B) with `_meta.source: 'claude'`
                      — the same code path EZEstimates uses. Not
                      merged into the panel's draft state; the
                      query invalidation in `aiPatch` refreshes
                      the pickers. Only rendered when the user has
                      write access. */}
              <div className="col-span-2 flex items-center justify-between border-b border-wp-stone/60 pb-1 pt-1">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
                    Timelines and Estimates
                  </span>
                  {canWrite ? (
                    <button
                      type="button"
                      aria-label={merged.dates_locked ? "Unlock dates" : "Lock dates"}
                      aria-pressed={merged.dates_locked}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded hover:bg-wp-stone/40 disabled:cursor-not-allowed disabled:opacity-40 ${
                        merged.dates_locked ? "text-wp-red" : "text-wp-slate"
                      }`}
                      disabled={lockToggle.isPending}
                      onClick={() => lockToggle.mutate(!merged.dates_locked)}
                      title={
                        merged.dates_locked
                          ? "Dates are locked \u2014 click to unlock. The auto-scheduler will not change locked dates."
                          : "Lock dates \u2014 prevent the auto-scheduler from changing them"
                      }
                    >
                      {merged.dates_locked ? <Lock size={16} /> : <LockOpen size={16} />}
                    </button>
                  ) : (
                    <span
                      aria-label={merged.dates_locked ? "Dates locked" : "Dates unlocked"}
                      className={`inline-flex h-7 w-7 items-center justify-center ${
                        merged.dates_locked ? "text-wp-red" : "text-wp-slate/60"
                      }`}
                      title={
                        merged.dates_locked
                          ? "Dates are locked \u2014 the auto-scheduler will not change them."
                          : "Dates are unlocked \u2014 the auto-scheduler may change them."
                      }
                    >
                      {merged.dates_locked ? <Lock size={16} /> : <LockOpen size={16} />}
                    </span>
                  )}
                </div>
                {canWrite ? (
                  <AiSuggestPopover
                    project={project}
                    sizes={tshirtSizes.data}
                    onAcceptPhase={aiHandlers.onAcceptPhase}
                    onAcceptAll={aiHandlers.onAcceptAll}
                  />
                ) : null}
              </div>
              {aiPatch.isError ? (
                <MutationErrorBanner
                  mutation={aiPatch}
                  className="col-span-2"
                />
              ) : null}
              <Field label="Discovery and Definition" className="col-span-2">
                <PairedDates
                  startLabel="Start"
                  startValue={merged.start_date}
                  onStartChange={(v) => markPhaseDateChange("start_date", v)}
                  endLabel="Ready for dev"
                  endValue={merged.target_date}
                  endMin={merged.start_date}
                  onEndChange={(v) => markPhaseDateChange("target_date", v)}
                  disabled={!canWrite || merged.dates_locked}
                />
              </Field>
              <Field
                label="Development"
                className="col-span-2"
                hint={!eff.target ? "Development picks up from Discovery's ‘Ready for dev’ when set — you can still schedule it independently." : undefined}
              >
                <PairedDates
                  startLabel="Start"
                  startValue={eff.devStart}
                  startMin={eff.target}
                  onStartChange={(v) => markPhaseDateChange("dev_start_date", v)}
                  endLabel="End"
                  endValue={eff.devEnd}
                  endMin={eff.devStart}
                  onEndChange={(v) => markPhaseDateChange("dev_end_date", v)}
                  disabled={!canWrite || merged.dates_locked}
                />
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-wp-ink">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-wp-red"
                    disabled={!canWrite}
                    checked={!!merged.dev_estimate_sourced_by_dev}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      dev_estimate_sourced_by_dev: e.target.checked,
                    }))}
                  />
                  <span>
                    Dev estimate confirmed by engineering
                    <span className="ml-1 text-wp-slate/80">
                      (until checked, the roadmap draws this segment with a dashed outline)
                    </span>
                  </span>
                </label>
              </Field>
              <Field
                label="Post-Dev Optimization"
                className="col-span-2"
                hint={!eff.devEnd && !eff.target ? "Post-Dev cascades from Development's end when set — you can still schedule it independently." : undefined}
              >
                <PairedDates
                  startLabel="Start"
                  startValue={eff.optStart}
                  startMin={eff.devEnd}
                  onStartChange={(v) => markPhaseDateChange("optimization_start_date", v)}
                  endLabel="End"
                  endValue={eff.optEnd}
                  endMin={eff.optStart}
                  onEndChange={(v) => markPhaseDateChange("optimization_end_date", v)}
                  disabled={!canWrite || merged.dates_locked}
                />
              </Field>
              <Field
                label="Capacity planning"
                className="col-span-2"
                hint="On by default. Uncheck for placeholder work, tracking-only items, or subtasks that share load with a parent you're already counting."
              >
                <label className="flex cursor-pointer items-start gap-2 text-sm text-wp-ink">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-wp-red"
                    disabled={!canWrite}
                    checked={!merged.excluded_from_capacity}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      excluded_from_capacity: !e.target.checked,
                    }))}
                  />
                  <span>
                    Count this item against owner &amp; team capacity
                  </span>
                </label>
              </Field>
              {/* Per-project Roadmap visibility toggle (migration 035).
                  Distinct from the Archive lane (which hides the item
                  from every view) — this ONLY drops the project from
                  the Roadmap surface (Gantt, Unscheduled list, Recent
                  Changes, headline, PDF export). The Board, Status
                  Report, EZEstimates, and admin lists still show it.
                  Uses the shared draft / Save flow (not a one-shot
                  mutation) so the toggle lands in the same PATCH as
                  any other pending edits and appears once in the
                  audit trail. */}
              <Field
                label="Roadmap visibility"
                className="col-span-2"
                hint="Hidden items never appear on the Roadmap view, even if they have valid dates."
              >
                <label className="flex cursor-pointer items-start gap-2 text-sm text-wp-ink">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-wp-red"
                    disabled={!canWrite}
                    checked={!!merged.hidden_from_roadmap}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      hidden_from_roadmap: e.target.checked,
                    }))}
                  />
                  <span>
                    Hide this item from the Roadmap view
                    <span className="ml-1 text-xs text-wp-slate/80">
                      (still visible on the Board, Status Report, and other views)
                    </span>
                  </span>
                </label>
              </Field>
            </div>

            <section className="mt-5">
              <h3 className="text-sm font-semibold text-wp-ink">Predicted timeline</h3>
              {phases.scheduled ? (
                <ul className="mt-1.5 space-y-1 text-xs text-wp-slate">
                  {phases.discovery ? (
                    <li>Phase 1 · Discovery/Definition — {format(phases.discovery.start, "MMM d")} → {format(phases.discovery.end, "MMM d")}</li>
                  ) : null}
                  {phases.awaitingDev ? (
                    <li className="text-amber-700">Awaiting Dev — {format(phases.awaitingDev.start, "MMM d")} → {format(phases.awaitingDev.end, "MMM d")}</li>
                  ) : null}
                  {phases.development ? (
                    <li>Phase 2 · Development — {format(phases.development.start, "MMM d")} → {format(phases.development.end, "MMM d")}</li>
                  ) : null}
                  {phases.awaitingOptimization ? (
                    <li className="text-amber-700">Awaiting Optimization — {format(phases.awaitingOptimization.start, "MMM d")} → {format(phases.awaitingOptimization.end, "MMM d")}</li>
                  ) : null}
                  {phases.optimization ? (
                    <li>Phase 3 · Post-Dev Optimization — {format(phases.optimization.start, "MMM d")} → {format(phases.optimization.end, "MMM d")}</li>
                  ) : null}
                </ul>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">
                  Fill in a phase (start + end) to plot this project on the Roadmap. Any single phase is enough — a post-dev-only project still shows its Optimization segment.
                </p>
              )}
            </section>

            <ProjectDeadlines project={project} />

            <ProjectDependencies project={project} />

            <ProjectLinks project={project} />

            {myChildren.length ? (
              <section className="mt-6">
                <h3 className="text-sm font-semibold text-wp-ink">
                  Subtasks <span className="text-xs font-normal text-wp-slate">({myChildren.length} direct)</span>
                </h3>
                <ul className="mt-2 space-y-1">
                  {myChildren.map((child) => {
                    const childLane = lanes.data?.find((l) => l.id === child.swim_lane_id);
                    const grandkids = kids.get(child.id) ?? [];
                    return (
                      <li key={child.id}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded border border-transparent px-2 py-1.5 text-left text-sm text-wp-ink hover:border-wp-stone hover:bg-wp-stone/30"
                          onClick={() => onOpenProject ? onOpenProject(child.id) : onClose()}
                          title={`Open ${child.title}`}
                        >
                          <TypeBadge type={child.type} />
                          <span className="min-w-0 flex-1 truncate">{child.title}</span>
                          <span className="text-[11px] text-wp-slate">
                            {childLane?.name ?? "—"}
                            {grandkids.length ? ` · ${grandkids.length} sub` : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {requiresStatus ? (
              <section className="mt-6 rounded-md border border-wp-stone bg-wp-bg p-3">
                <h3 className="text-sm font-semibold text-wp-ink">This week&rsquo;s status</h3>
                <StatusUpdateForm projectId={id} />
              </section>
            ) : null}

            <section className="mt-6">
              <h3 className="text-sm font-semibold text-wp-ink">Weekly status history</h3>
              {statusUpdates.data && statusUpdates.data.length ? (
                <ul className="mt-2 space-y-3">
                  {statusUpdates.data.map((u) => <StatusHistoryRow key={u.id} u={u} />)}
                </ul>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">No status updates yet for this project.</p>
              )}
            </section>

            <section className="mt-6">
              <ProjectComments projectId={id} />
            </section>

            <section className="mt-6">
              <h3 className="text-sm font-semibold text-wp-ink">Audit trail</h3>
              {history.data && history.data.length ? (
                <ol className="mt-2 space-y-1 text-xs text-wp-slate">
                  {/* Backend returns oldest-first (chronological). PMs
                      read the panel like a changelog and want the newest
                      event on top; reverse a shallow copy so the source
                      array stays untouched for any other consumer. */}
                  {history.data.slice().reverse().map((h) => (
                    <HistoryRow key={h.id} h={h} allProjectsById={byId} />
                  ))}
                </ol>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">No activity yet.</p>
              )}
            </section>
          </div>

          {canWrite ? (
            <div className="border-t border-wp-stone bg-white px-5 py-3">
              <CapacityWarning
                intervals={draftOverloads}
                users={users.data ?? []}
                teams={teams.data ?? []}
                className="mb-2"
              />
              <MutationErrorBanner mutation={patch} className="mb-2" />
              <MutationErrorBanner mutation={archive} className="mb-2" />
              <MutationErrorBanner mutation={lockToggle} className="mb-2" />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button className="btn-ghost text-xs" onClick={onClose}>Cancel</button>
                  {canArchive ? (
                    <button
                      type="button"
                      className="btn-ghost text-xs text-wp-slate hover:text-red-600"
                      disabled={archive.isPending}
                      onClick={() => {
                        if (confirm(
                          "Move this item to Archive?\n\nIt will disappear from the board and be hidden from non-admin users. Admins can restore it by moving it back into any other lane.",
                        )) {
                          archive.mutate();
                        }
                      }}
                    >
                      {archive.isPending ? "Archiving…" : "Move to archive"}
                    </button>
                  ) : null}
                </div>
                <button
                  className="btn-primary"
                  disabled={Object.keys(draft).length === 0 || patch.isPending}
                  onClick={() => {
                    // Build `_meta` for the backend's per-phase
                    // provenance stamping. We attach it only when
                    // this save actually touches a phase date — an
                    // owner / tag / title edit doesn't need it, and
                    // sending an empty `editedPhases` array would
                    // cause every cascaded shift to be labelled
                    // 'cascade' with no accompanying direct-edit
                    // stamp (still correct, but noisier).
                    const filled = fillMissingPhaseDates(draft, project);
                    const editedPhases = new Set<
                      "discovery" | "development" | "post_dev"
                    >();
                    for (const field of PHASE_DATE_FIELD_NAMES) {
                      if (touchedPhaseFields.has(field as string)) {
                        editedPhases.add(PHASE_FIELD_TO_KEY[field as string]!);
                      }
                    }
                    const patchesPhaseDate = PHASE_DATE_FIELD_NAMES.some(
                      (f) => (filled as Record<string, unknown>)[f as string] !== undefined,
                    );
                    if (patchesPhaseDate) {
                      patch.mutate({
                        ...filled,
                        _meta: {
                          source: "user",
                          editedPhases: Array.from(editedPhases),
                        },
                      });
                    } else {
                      patch.mutate(filled);
                    }
                  }}
                >
                  {patch.isPending ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-wp-stone bg-white px-5 py-3 text-xs text-wp-slate">
              Viewer — read-only.
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, className, hint, children }: { label: string; className?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-wp-slate">{label}</span>
        {hint ? <span className="text-[10px] italic text-wp-slate/80">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/**
 * When a user edits an earlier phase-date, any explicitly-set later date
 * that would now sit before its predecessor is cleared, restoring the
 * default-cascade behavior. Fields that were already null keep tracking
 * their upstream defaults automatically.
 */
function cascadeClear(next: Draft, base: Project): Draft {
  const m = { ...base, ...next };
  const clear = (k: keyof Draft) => {
    (next as Record<string, unknown>)[k] = null;
    (m as Record<string, unknown>)[k] = null;
  };
  if (m.start_date && m.target_date && m.target_date < m.start_date) clear("target_date");
  if (m.dev_start_date && m.target_date && m.dev_start_date < m.target_date) clear("dev_start_date");
  const effDevStart = m.dev_start_date ?? m.target_date;
  if (m.dev_end_date && effDevStart && m.dev_end_date < effDevStart) clear("dev_end_date");
  if (m.optimization_start_date && m.dev_end_date && m.optimization_start_date < m.dev_end_date) {
    clear("optimization_start_date");
  }
  const effOptStart = m.optimization_start_date ?? m.dev_end_date;
  if (m.optimization_end_date && effOptStart && m.optimization_end_date < effOptStart) {
    clear("optimization_end_date");
  }
  return next;
}

function StatusHistoryRow({ u }: { u: WeeklyStatusUpdate }) {
  return (
    <li className="rounded border border-wp-stone bg-white p-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="font-medium text-wp-ink">Week of {u.week_of}</div>
        <StatusPill flag={u.health_flag} completed={u.completed} size="md" />
      </div>
      {u.executive_summary ? (
        <div className="mt-1 text-wp-slate">{u.executive_summary}</div>
      ) : null}
      {u.detailed_update.length ? (
        <ul className="ml-4 mt-1 list-disc text-wp-slate">
          {u.detailed_update.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

function HistoryRow({ h, allProjectsById }: { h: ProjectTimelineEntry; allProjectsById?: Map<string, Project> }) {
  const users = useUsers();
  const lanes = useSwimLanes();
  const teams = useTeams();
  const kpis = useKpis();
  const who = auditActorLabel(h, users.data ?? []);
  return (
    <li className="leading-relaxed">
      <span className="text-wp-slate/80">{format(new Date(h.timestamp), "yyyy-MM-dd HH:mm")}</span>
      {" · "}
      <span>{who}</span>{" "}
      <AuditEventBody
        entry={timelineEntryToRenderEntry(h)}
        lanes={lanes.data ?? []}
        teams={teams.data ?? []}
        users={users.data ?? []}
        kpis={kpis.data ?? []}
        projectsById={allProjectsById}
      />
    </li>
  );
}

/** Compact "epic" / "subtask" chip. Colored to nudge epics as the
 *  primary structural unit. */
function TypeBadge({ type }: { type: ProjectType }) {
  return (
    <span
      className={
        type === "epic"
          ? "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-wp-red/10 text-wp-red"
          : "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-wp-stone/60 text-wp-slate"
      }
    >
      {type}
    </span>
  );
}
