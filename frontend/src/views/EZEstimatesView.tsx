import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { FilterBar } from "../components/FilterBar";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { PhaseSizePicker } from "../components/PhaseSizePicker";
import { api } from "../lib/api";
import { applyFilters } from "../lib/filtering";
import { addIsoDays, todayIso, type PhaseDateFields } from "../lib/phaseDates";
import { useProjects, useSwimLanes, useTshirtSizes } from "../lib/queries";
import type { Project } from "../lib/types";
import { useViewStore } from "../lib/viewState";

/**
 * Phase definitions used by both the cascade helper and the row
 * renderer. Ordered earliest → latest so the cascade loop can walk
 * from the touched phase forward.
 */
const PHASES = [
  { key: "discovery",   label: "Discovery",   startField: "start_date",              endField: "target_date"           },
  { key: "development", label: "Development", startField: "dev_start_date",          endField: "dev_end_date"          },
  { key: "postDev",     label: "Post-Dev",    startField: "optimization_start_date", endField: "optimization_end_date" },
] as const;

type PhaseDef = (typeof PHASES)[number];
type PhaseKey = PhaseDef["key"];

/**
 * Fields on `Project` the cascade may touch. Narrowed to just the
 * six phase-date columns so TypeScript can prove we never write
 * something unexpected via the PATCH body.
 */
type PhaseDatePatch = Partial<PhaseDateFields>;

/** Count of whole days from `from` → `to`. Positive when `to` is
 *  later. Both inputs are YYYY-MM-DD strings. */
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Length of a phase in days, or null when either bound is unset. */
function phaseLengthDays(p: Project, phase: PhaseDef): number | null {
  const start = p[phase.startField as keyof Project] as string | null;
  const end   = p[phase.endField   as keyof Project] as string | null;
  if (!start || !end) return null;
  return daysBetween(start, end);
}

/**
 * Cascade computation for the EZEstimates size-pick action.
 *
 * Given a project, the phase the user just sized, and the new day
 * count, produces a minimal PATCH body that:
 *
 *   1. Sets the sized phase to (existing start, start + N).
 *      - If the phase had no start, uses today.
 *      - The size the PM clicked ALWAYS wins for that phase; we
 *        never keep the old end.
 *
 *   2. Cascades any change to subsequent phases:
 *
 *      Case A (touched phase had a persisted end date):
 *        delta = newEnd − oldEnd
 *        Every subsequent phase that has ANY date set shifts
 *        every set date by `delta`. Preserves phase LENGTHS and
 *        the pairwise "dev starts after discovery ends, opt starts
 *        after dev ends" constraint the backend enforces.
 *
 *      Case B (touched phase had NO persisted end date — fresh
 *      stamp of both start and end):
 *        We can't compute a signed delta. Instead each subsequent
 *        phase with dates gets the MINIMUM forward shift needed to
 *        satisfy the boundary constraint against the running
 *        upstream-end anchor. Phases already comfortably after the
 *        touched phase's new end don't move at all.
 *
 *   3. Never fills a subsequent phase that was fully blank. A
 *      blank Development stays blank when the user only sizes
 *      Discovery.
 *
 * The output is *exactly* the patch fields that changed — no
 * spurious keys that the backend would then audit-log as
 * "no-op" edits.
 */
export function computeCascadePatch(
  project: Pick<Project, "start_date" | "target_date" | "dev_start_date" | "dev_end_date" | "optimization_start_date" | "optimization_end_date">,
  phaseKey: PhaseKey,
  newDays: number,
  today: string = todayIso(),
): PhaseDatePatch {
  const idx = PHASES.findIndex((p) => p.key === phaseKey);
  if (idx < 0) return {};
  const phase = PHASES[idx]!;

  const oldStart = project[phase.startField] as string | null;
  const oldEnd   = project[phase.endField]   as string | null;

  // Phase start stays put when set; otherwise fall back to today.
  // Only the END slides to accommodate the new N-day length.
  const newStart = oldStart ?? today;
  const newEnd = addIsoDays(newStart, newDays)!;

  const patch: PhaseDatePatch = {};
  if (newStart !== oldStart) patch[phase.startField] = newStart;
  if (newEnd !== oldEnd)     patch[phase.endField]   = newEnd;

  // Delta cascade only fires when the touched phase already had an
  // end date to measure against. Fresh stamps use the boundary-
  // preserving branch below.
  const hadOldEnd = !!oldEnd;
  const delta = hadOldEnd ? daysBetween(oldEnd!, newEnd) : 0;

  // Running upstream-end anchor. When the touched phase's new end
  // pushes forward, this drives the "min forward shift" the
  // boundary branch needs for each downstream phase in turn.
  let anchorEnd = newEnd;

  for (let i = idx + 1; i < PHASES.length; i++) {
    const p = PHASES[i]!;
    const pStart = project[p.startField] as string | null;
    const pEnd   = project[p.endField]   as string | null;

    if (!pStart && !pEnd) continue;

    let shift: number;
    if (hadOldEnd) {
      // Case A: uniform delta preserves the length AND the gap to
      // the previous phase. Works for both extensions and shrinks.
      shift = delta;
    } else {
      // Case B: only shift as much as we need to keep this phase's
      // earliest set date on or after the running upstream anchor.
      // Already-set future dates that are well clear of the touched
      // phase are left alone.
      const earliest = pStart ?? pEnd!;
      shift = earliest < anchorEnd ? daysBetween(earliest, anchorEnd) : 0;
    }

    if (shift !== 0) {
      if (pStart) {
        const nextStart = addIsoDays(pStart, shift)!;
        if (nextStart !== pStart) patch[p.startField] = nextStart;
      }
      if (pEnd) {
        const nextEnd = addIsoDays(pEnd, shift)!;
        if (nextEnd !== pEnd) patch[p.endField] = nextEnd;
      }
    }

    // Advance the anchor to this phase's (post-shift) end so the
    // next downstream phase measures against the correct boundary.
    // Falls back to start when end is unset — start-only phases are
    // legal under the pairwise validator, just unusual.
    const finalEnd = pEnd
      ? addIsoDays(pEnd, shift)!
      : pStart
      ? addIsoDays(pStart, shift)!
      : anchorEnd;
    anchorEnd = finalEnd;
  }

  return patch;
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
  const filters = useViewStore((s) => s.ezestimates.filters);
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

  const rows = useMemo(() => {
    const raw = projects.data ?? [];
    // applyFilters already skips soft-deleted rows AND applies the
    // FilterBar's owner/team/tag/search picks against the per-view
    // filter state we passed in.
    const filtered = applyFilters(raw, filters);
    // Then drop anything living in a hidden lane. Rows with no lane
    // at all stay visible so a mis-provisioned project is still
    // reachable through this view.
    return filtered.filter(
      (p) => !p.swim_lane_id || !hiddenLaneIds.has(p.swim_lane_id),
    );
  }, [projects.data, filters, hiddenLaneIds]);

  // One mutation shared across every row — TanStack Query serializes
  // concurrent invocations of the same key internally, and a shared
  // mutation lets us render one banner at the top on failure.
  const patchProject = useMutation({
    mutationFn: (args: { projectId: string; body: PhaseDatePatch }) =>
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

  function handlePickSize(project: Project, phase: PhaseDef, days: number) {
    const patch = computeCascadePatch(project, phase.key, days);
    if (Object.keys(patch).length === 0) return;
    patchProject.mutate({ projectId: project.id, body: patch });
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
      <div className="border-b border-wp-stone bg-white/60 px-4 py-2 text-sm">
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
              return (
                <li key={project.id} className="px-4 py-2">
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(project.id)}
                      aria-label={isOpen ? "Collapse description" : "Expand description"}
                      aria-expanded={isOpen}
                      className="mt-0.5 shrink-0 text-wp-slate hover:text-wp-ink"
                    >
                      {isOpen ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
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
                    {/* Fixed-width phase-picker rail. `w-[7.5rem]` per
                        column keeps the S/M/L pickers vertically
                        aligned across rows even when phase labels
                        differ in length. */}
                    <div className="flex shrink-0 items-start gap-2">
                      {PHASES.map((phase) => {
                        const currentDays = phaseLengthDays(project, phase);
                        return (
                          <div
                            key={phase.key}
                            className="flex w-[7.5rem] flex-col items-end gap-0.5"
                          >
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
                      })}
                    </div>
                  </div>
                  {isOpen ? (
                    <div className="mt-2 whitespace-pre-wrap pl-6 text-xs text-wp-slate">
                      {project.description?.trim() ? (
                        project.description
                      ) : (
                        <span className="italic text-wp-slate/70">
                          No description.
                        </span>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
