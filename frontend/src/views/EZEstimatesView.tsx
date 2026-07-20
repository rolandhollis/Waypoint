import { Fragment, useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import {
  AiSuggestPopover,
  type AiSuggestBatchCascade,
  type AiSuggestPhaseCascade,
} from "../components/AiSuggestPopover";
import { Collapsible } from "../components/Collapsible";
import { EstimateProvenanceChip } from "../components/EstimateProvenanceChip";
import { FilterBar } from "../components/FilterBar";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { PhaseSizePicker } from "../components/PhaseSizePicker";
import { ViolationChip } from "../components/ViolationChip";
import { ViolationToast } from "../components/ViolationToast";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { applyFilters } from "../lib/filtering";
import {
  AI_TO_EZ_PHASE,
  EZ_TO_BACKEND_PHASE,
  PHASES,
  computeCascadePatch,
  type PhaseDatePatch,
  type PhaseDef,
} from "../lib/phaseCascade";
import { useCanWrite, useProjects, useSwimLanes, useTshirtSizes, useUsers } from "../lib/queries";
import type { Project, SwimLane, User } from "../lib/types";
import { useViewStore } from "../lib/viewState";
import {
  computeProjectViolations,
  diffViolations,
  hasDelta,
  type ViolationDelta,
  type ViolationSet,
} from "../lib/violations";

/** Length of a phase in days, or null when either bound is unset. */
function phaseLengthDays(p: Project, phase: PhaseDef): number | null {
  const start = p[phase.startField as keyof Project] as string | null;
  const end   = p[phase.endField   as keyof Project] as string | null;
  if (!start || !end) return null;
  const a = new Date(`${start}T00:00:00`).getTime();
  const b = new Date(`${end}T00:00:00`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * EZEstimates view — flat list of every non-terminal, non-archived,
 * non-parking-lot project with three T-shirt size pickers per row
 * (Discovery / Development / Post-Dev). Picking a size sends ONE
 * atomic PATCH per project containing every cascaded phase-date
 * change so the audit trail stays clean.
 */
export function EZEstimatesView() {
  const projects = useProjects();
  const lanes = useSwimLanes();
  const sizes = useTshirtSizes();
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const filters = useViewStore((s) => s.ezestimates.filters);
  // EZEstimates-only filter dropdowns (persisted in the ezestimates
  // slice). Kept as individual selectors so a change to one control
  // doesn't rerender for the other.
  const createdWithinDays = useViewStore((s) => s.ezestimates.createdWithinDays);
  const devSourced = useViewStore((s) => s.ezestimates.devSourced);
  const setCreatedWithinDays = useViewStore((s) => s.setEzestimatesCreatedWithinDays);
  const setDevSourced = useViewStore((s) => s.setEzestimatesDevSourced);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Which lanes to hide. Terminal + archive are schema flags;
  // "Parking Lot" is the same case-insensitive convention the Board
  // uses for its quick-actions row so we don't diverge in any
  // future rename.
  const hiddenLaneIds = useMemo(() => {
    const set = new Set<string>();
    for (const lane of lanes.data ?? []) {
      if (lane.is_terminal || lane.is_archive) set.add(lane.id);
      else if (lane.name.trim().toLowerCase() === "parking lot") set.add(lane.id);
    }
    return set;
  }, [lanes.data]);

  // Cutoff timestamp for the "Created within last N days" dropdown.
  // Computed once per (createdWithinDays) change, not per row. Uses
  // local time as spec'd: N * 86_400_000 ms subtracted from now, and
  // the comparison below is inclusive of the boundary.
  const createdCutoffMs = useMemo(() => {
    if (createdWithinDays === null) return null;
    return Date.now() - createdWithinDays * 24 * 60 * 60 * 1000;
  }, [createdWithinDays]);

  const rows = useMemo(() => {
    const raw = projects.data ?? [];
    // applyFilters already skips soft-deleted rows AND applies the
    // FilterBar's owner/team/tag/search picks against the per-view
    // filter state we passed in.
    const filtered = applyFilters(raw, filters);
    // Then drop anything living in a hidden lane. Rows with no lane
    // at all stay visible so a mis-provisioned project is still
    // reachable through this view.
    return filtered.filter((p) => {
      if (p.swim_lane_id && hiddenLaneIds.has(p.swim_lane_id)) return false;
      // EZEstimates-only "Created" filter. Inclusive of the cutoff so
      // a project created exactly N days ago still shows up.
      if (createdCutoffMs !== null) {
        const createdMs = new Date(p.created_at).getTime();
        if (!Number.isFinite(createdMs) || createdMs < createdCutoffMs) return false;
      }
      // EZEstimates-only "Dev-sourced" filter. "any" bypasses.
      if (devSourced === "yes" && p.dev_estimate_sourced_by_dev !== true) return false;
      if (devSourced === "no" && p.dev_estimate_sourced_by_dev !== false) return false;
      return true;
    });
  }, [projects.data, filters, hiddenLaneIds, createdCutoffMs, devSourced]);

  // Users query used by the row-level provenance chip. Kept out of
  // the inner render loop so every row uses the same cached map
  // regardless of how many pickers fire in a session.
  const users = useUsers();
  const usersById = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of users.data ?? []) m.set(u.id, u);
    return m;
  }, [users.data]);

  // Two O(1) lookup maps used by the deadline + dependency
  // violation calculators. Computed once per (lanes / projects)
  // query snapshot so every row's chip / toast reads through the
  // same view of the world; without these each row would either
  // rebuild the maps in its render loop (O(n²)) or the violation
  // check would silently miss a rename mid-poll.
  const lanesById = useMemo(() => {
    const m = new Map<string, SwimLane>();
    for (const lane of lanes.data ?? []) m.set(lane.id, lane);
    return m;
  }, [lanes.data]);
  const projectsById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects.data ?? []) m.set(p.id, p);
    return m;
  }, [projects.data]);

  // Per-row toast state — one bucket per project id, cleared on
  // dismiss (auto after ~8s or explicit ×). The `nonce` bumps on
  // every new toast so a rapid second violation on the same row
  // remounts the toast component (and resets the auto-dismiss
  // timer) instead of stacking.
  const [toasts, setToasts] = useState<
    Record<string, { delta: ViolationDelta; nonce: number }>
  >({});
  const dismissToast = useCallback((projectId: string) => {
    setToasts((prev) => {
      if (!prev[projectId]) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  // One mutation shared across every row — TanStack Query serializes
  // concurrent invocations of the same key internally, and a shared
  // mutation lets us render one banner at the top on failure.
  //
  // Body shape: the phase-date patch plus the provenance `_meta`
  // envelope so the backend can stamp per-phase `_updated_*` columns
  // (see backend/src/routes/projects.ts PATCH handler + migration
  // 032). The `_meta` field is out-of-band (leading underscore) —
  // the backend accepts it in the same zod schema as the persisted
  // columns, but it never ends up in the row itself.
  const patchProject = useMutation({
    mutationFn: (args: {
      projectId: string;
      body: PhaseDatePatch & {
        _meta: { source: "user" | "claude"; editedPhases: readonly ("discovery" | "development" | "post_dev")[] };
      };
    }) =>
      api<Project>(`/projects/${args.projectId}`, {
        method: "PATCH",
        body: JSON.stringify(args.body),
      }),
    onSuccess: () => {
      // Full projects list refetch — cheap, and it also refreshes
      // the roadmap/board caches that share the same key. History
      // is fetched on demand so we don't need to invalidate it
      // here.
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  // Dedicated mutation for the "dev estimate confirmed by engineering"
  // flag next to the Development picker. Kept separate from
  // `patchProject` so its body type stays narrowed to phase dates and
  // the audit-log entries don't co-mingle date shifts with the flag
  // toggle. Optimistic: flip the cached row instantly so the tick
  // feels responsive, then invalidate on settle for a canonical
  // refresh.
  const toggleDevConfirmed = useMutation({
    mutationFn: (args: { projectId: string; value: boolean }) =>
      api<Project>(`/projects/${args.projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ dev_estimate_sourced_by_dev: args.value }),
      }),
    onMutate: async ({ projectId, value }) => {
      await qc.cancelQueries({ queryKey: ["projects"] });
      const previous = qc.getQueryData<Project[]>(["projects"]);
      if (previous) {
        qc.setQueryData<Project[]>(
          ["projects"],
          previous.map((p) =>
            p.id === projectId
              ? { ...p, dev_estimate_sourced_by_dev: value }
              : p,
          ),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(["projects"], ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  /**
   * Fire the shared cascade PATCH for a single phase-size pick.
   *
   * `source` is passed straight through to the backend's `_meta`
   * envelope. `editedPhases` is ALWAYS a one-element list because
   * this view only lets the user (or Claude) touch one phase per
   * click — the cascade helper below shifts later phases as a
   * derived effect, and the backend infers 'cascade' for those.
   *
   * Violation snapshotting: we compute the project's deadline +
   * dependency violation set BEFORE the PATCH fires (against the
   * current projects list), and re-compute AFTER using the mutated
   * project the backend returned. If the diff reveals a NEW miss
   * or a WORSER overrun, we stash a per-row toast so the PM sees
   * the impact without switching to the Roadmap. Improvements
   * (or equivalent-severity carry-overs) fall through silently.
   */
  function handlePickSize(
    project: Project,
    phase: PhaseDef,
    days: number,
    source: "user" | "claude" = "user",
  ) {
    const patch = computeCascadePatch(project, phase.key, days);
    if (Object.keys(patch).length === 0) return;
    const before: ViolationSet = computeProjectViolations(project, lanesById, projectsById);
    patchProject.mutate(
      {
        projectId: project.id,
        body: {
          ...patch,
          _meta: {
            source,
            editedPhases: [EZ_TO_BACKEND_PHASE[phase.key]],
          },
        },
      },
      {
        onSuccess: (updated) => {
          // Swap the mutated project into the lookup map so any
          // dependency edge back to THIS project resolves against
          // the fresh dates. We deliberately re-use the cached
          // lanes + projects snapshot rather than waiting for the
          // invalidate refetch — the diff we care about is "did
          // THIS click break something," not the whole-world view.
          const nextProjectsById = new Map(projectsById);
          nextProjectsById.set(updated.id, updated);
          const after = computeProjectViolations(updated, lanesById, nextProjectsById);
          const delta = diffViolations(before, after);
          if (!hasDelta(delta)) return;
          setToasts((prev) => ({
            ...prev,
            [updated.id]: {
              delta,
              nonce: (prev[updated.id]?.nonce ?? 0) + 1,
            },
          }));
        },
      },
    );
  }

  /**
   * Bridge between the AI popover's `(aiKey, days)` contract and
   * the view's `(project, phaseDef, days)` cascade helper. Curried
   * so each row can hand the popover a callback bound to its own
   * project without capturing stale state. Accepts a `source`
   * argument so the caller (manual click vs Claude accept) can
   * flag which provenance value the backend should stamp for the
   * DIRECTLY-edited phase — downstream cascaded phases still land
   * as 'cascade' regardless of source.
   */
  function makeAiCascade(
    project: Project,
    dispatch: (
      project: Project,
      phase: PhaseDef,
      days: number,
      source: "user" | "claude",
    ) => void,
    source: "user" | "claude",
  ): AiSuggestPhaseCascade {
    return (aiKey, days) => {
      const ezKey = AI_TO_EZ_PHASE[aiKey];
      const phase = PHASES.find((p) => p.key === ezKey);
      if (!phase) return;
      dispatch(project, phase, days, source);
    };
  }

  /**
   * Batch-accept handler for the AiSuggestPopover's "Accept all"
   * button. Walks the requested phases in order threading a
   * running "virtual project" through {@link computeCascadePatch}
   * so each phase's cascade sees the previous phases' new dates,
   * then dispatches ONE atomic PATCH covering every phase-date
   * that actually changed.
   *
   * Fixes the race the previous per-phase loop had: three fire-
   * and-forget mutations dispatched from a captured `project`
   * snapshot, arriving at the server near-simultaneously. Post-
   * Dev's `optimization_start_date`, computed from the stale
   * `target_date`, was rejected by the non-decreasing chain
   * validator because Development's in-flight PATCH had already
   * pushed `dev_end_date` past that boundary — silently breaking
   * every Accept-All that included Post-Dev on a project with
   * no persisted dev dates. Single-phase Accept was fine because
   * only one mutation flew.
   *
   * `_meta.editedPhases` lists every phase whose date pair
   * actually moved in this PATCH so the backend stamps them as
   * `source` (typically 'claude'). Phases skipped for having a
   * same-size suggestion don't get stamped, matching the manual
   * `handlePickSize` behavior for no-op picks.
   */
  function makeAiAcceptAllCascade(
    project: Project,
    source: "user" | "claude",
  ): AiSuggestBatchCascade {
    return (phases) => {
      let running: Project = project;
      let combined: PhaseDatePatch = {};
      const edited: ("discovery" | "development" | "post_dev")[] = [];
      for (const { phaseKey, days } of phases) {
        const ezKey = AI_TO_EZ_PHASE[phaseKey];
        const patch = computeCascadePatch(running, ezKey, days);
        if (Object.keys(patch).length === 0) continue;
        combined = { ...combined, ...patch };
        running = { ...running, ...patch };
        edited.push(phaseKey);
      }
      if (edited.length === 0) return;
      const before: ViolationSet = computeProjectViolations(
        project,
        lanesById,
        projectsById,
      );
      patchProject.mutate(
        {
          projectId: project.id,
          body: {
            ...combined,
            _meta: { source, editedPhases: edited },
          },
        },
        {
          onSuccess: (updated) => {
            const nextProjectsById = new Map(projectsById);
            nextProjectsById.set(updated.id, updated);
            const after = computeProjectViolations(
              updated,
              lanesById,
              nextProjectsById,
            );
            const delta = diffViolations(before, after);
            if (!hasDelta(delta)) return;
            setToasts((prev) => ({
              ...prev,
              [updated.id]: {
                delta,
                nonce: (prev[updated.id]?.nonce ?? 0) + 1,
              },
            }));
          },
        },
      );
    };
  }

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar view="ezestimates" />
      {/* EZEstimates-only extra filter row. Kept separate from the
          shared FilterBar so we don't couple its API to a single
          view's needs; wraps naturally on narrow screens because the
          FilterBar above already uses flex-wrap. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-wp-stone bg-white/60 px-4 py-2 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-wp-slate">Created</span>
          <select
            className="input !w-36 !py-1 !text-xs"
            value={createdWithinDays === null ? "all" : String(createdWithinDays)}
            onChange={(e) => {
              const v = e.target.value;
              setCreatedWithinDays(v === "all" ? null : (Number(v) as 7 | 14 | 30));
            }}
          >
            <option value="all">All time</option>
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-wp-slate">Dev-sourced</span>
          <select
            className="input !w-24 !py-1 !text-xs"
            value={devSourced}
            onChange={(e) => setDevSourced(e.target.value as "any" | "yes" | "no")}
          >
            <option value="any">Any</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      </div>
      <div className="border-b border-wp-stone bg-white/60 py-2 pl-4 pr-6 text-sm">
        <span className="font-semibold text-wp-ink">EZEstimates</span>
        <span className="ml-2 text-xs text-wp-slate">
          {rows.length} project{rows.length === 1 ? "" : "s"} · pick a T-shirt
          size to set a phase length; subsequent phases shift to preserve their
          lengths.
        </span>
      </div>

      <MutationErrorBanner mutation={patchProject} className="mx-4 mt-3" />

      <div className="flex-1 overflow-auto">
        {projects.isLoading ? (
          <div className="p-6 text-sm text-wp-slate">Loading projects…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-wp-slate">
            No projects match the current filters.
          </div>
        ) : (
          <ul className="divide-y divide-wp-stone">
            {rows.map((project) => {
              const isOpen = expandedIds.has(project.id);
              // Per-row violation snapshot. Cheap enough to compute
              // inline (list rarely exceeds a few hundred rows) and
              // keeps the chip in sync with any background poll —
              // hoisting it into a project-id-keyed memo would leak
              // stale statuses if a swim-lane rename landed between
              // renders.
              const rowViolations = computeProjectViolations(
                project,
                lanesById,
                projectsById,
              );
              const rowToast = toasts[project.id];
              return (
                <li key={project.id} className="py-2 pl-4 pr-6">
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(project.id)}
                      aria-label={isOpen ? "Collapse description" : "Expand description"}
                      aria-expanded={isOpen}
                      className="mt-0.5 shrink-0 text-wp-slate hover:text-wp-ink"
                    >
                      <ChevronRight
                        size={14}
                        className={cn(
                          "transition-transform duration-200 ease-out motion-reduce:transition-none",
                          isOpen && "rotate-90",
                        )}
                      />
                    </button>
                    {/* Clickable title area — also toggles expansion so
                        a PM can hit the whole row's description slot
                        instead of aiming at the tiny chevron. */}
                    <button
                      type="button"
                      onClick={() => toggleExpanded(project.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="whitespace-normal text-sm text-wp-ink">
                        {project.title}
                      </div>
                    </button>
                    {/* AI phase-size suggester. Fires the SAME
                        cascade helper the manual pickers use so
                        accepting a suggestion is byte-for-byte
                        identical to a manual click — audit trail,
                        downstream shifts, and dev-confirmed flag
                        all behave the same. Provenance source is
                        'claude' for accepts here so the row chip
                        reads "Claude" (not the acting user's
                        name) after an accept. */}
                    <div className="mt-4 shrink-0 self-start">
                      <AiSuggestPopover
                        project={project}
                        sizes={sizes.data}
                        onAcceptPhase={makeAiCascade(project, handlePickSize, "claude")}
                        onAcceptAll={makeAiAcceptAllCascade(project, "claude")}
                      />
                    </div>
                    {/* Provenance chip — "Updated <M/D/YY> · <source>".
                        Extract into its own component so a NULL-across-
                        the-board project cleanly renders nothing (the
                        row collapses this slot rather than reserving
                        placeholder space). Hover reveals a per-phase
                        breakdown table. */}
                    <div className="mt-4 shrink-0 self-start">
                      <EstimateProvenanceChip
                        project={project}
                        usersById={usersById}
                      />
                    </div>
                    {/* Always-on violation chip. Sits immediately
                        AFTER the provenance chip so the row's
                        left-to-right reading order flows title →
                        AI suggest → provenance → warning →
                        pickers. Renders nothing when the project
                        has no active violations; hover reveals a
                        deadline/dep breakdown identical in shape
                        to the roadmap's red-triangle tooltip. */}
                    <div className="mt-4 shrink-0 self-start">
                      <ViolationChip violations={rowViolations} />
                    </div>
                    {/* Fixed-width phase-picker rail. `w-[7.5rem]` per
                        column keeps the S/M/L pickers vertically
                        aligned across rows even when phase labels
                        differ in length. */}
                    <div className="flex shrink-0 items-start gap-2">
                      {PHASES.map((phase) => {
                        const currentDays = phaseLengthDays(project, phase);
                        const column = (
                          <div className="flex w-[7.5rem] flex-col items-end gap-0.5">
                            <span className="text-[10px] uppercase tracking-wide text-wp-slate/70">
                              {phase.label}
                            </span>
                            <PhaseSizePicker
                              phaseLabel={phase.label}
                              currentDays={currentDays}
                              sizes={sizes.data}
                              onPickSize={(days) =>
                                handlePickSize(project, phase, days)
                              }
                            />
                          </div>
                        );
                        // The "dev estimate confirmed by engineering"
                        // flag lives inline next to the Development
                        // picker — it's a property of that estimate,
                        // not a row-level toggle. Invisible spacer
                        // span mirrors the phase-label row so the
                        // checkbox lines up vertically with the
                        // pickers in the adjacent columns.
                        if (phase.key === "development") {
                          return (
                            <Fragment key={phase.key}>
                              {column}
                              <label
                                className="flex shrink-0 flex-col items-center gap-0.5"
                                title="Dev estimate confirmed by engineering (roadmap dashes unconfirmed segments)"
                              >
                                <span
                                  aria-hidden="true"
                                  className="invisible text-[10px] uppercase tracking-wide"
                                >
                                  .
                                </span>
                                <input
                                  type="checkbox"
                                  aria-label="Dev estimate confirmed by engineering"
                                  className="mt-1 h-3.5 w-3.5 accent-wp-red disabled:cursor-not-allowed disabled:opacity-50"
                                  disabled={!canWrite}
                                  checked={!!project.dev_estimate_sourced_by_dev}
                                  onChange={(e) =>
                                    toggleDevConfirmed.mutate({
                                      projectId: project.id,
                                      value: e.target.checked,
                                    })
                                  }
                                />
                              </label>
                            </Fragment>
                          );
                        }
                        return (
                          <Fragment key={phase.key}>{column}</Fragment>
                        );
                      })}
                    </div>
                  </div>
                  {rowToast ? (
                    <ViolationToast
                      // Key on the nonce so a rapid follow-up
                      // click on the same row remounts (and
                      // resets the auto-dismiss timer) instead of
                      // silently replacing the delta payload while
                      // the old timer keeps counting down.
                      key={rowToast.nonce}
                      delta={rowToast.delta}
                      onDismiss={() => dismissToast(project.id)}
                    />
                  ) : null}
                  <Collapsible open={isOpen}>
                    <div className="mt-2 whitespace-pre-wrap pl-6 text-xs text-wp-slate">
                      {project.description?.trim() ? (
                        project.description
                      ) : (
                        <span className="italic text-wp-slate/70">
                          No description.
                        </span>
                      )}
                    </div>
                  </Collapsible>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
