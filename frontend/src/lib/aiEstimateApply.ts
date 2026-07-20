/**
 * AiSuggestPopover accept-handler factory.
 *
 * Wraps `computeCascadePatch` + the `_meta` provenance envelope into
 * a pair of callbacks matching the popover's `AiSuggestPhaseCascade`
 * and `AiSuggestBatchCascade` contracts. Any view that hosts the
 * popover can build its `onAcceptPhase` / `onAcceptAll` in one call,
 * pointed at whichever `patchProject` mutation that view already
 * runs for phase-date edits.
 *
 * EZEstimates keeps its own bespoke handlers (`handlePickSize` +
 * `makeAiCascade` + `makeAiAcceptAllCascade`) because the row also
 * needs to run a before/after violation diff + toast on the same
 * project — the manual T-shirt picker fires the same code path and
 * we don't want to plumb toast state into a shared factory just for
 * one caller. This factory is intended for surfaces (Detail Panel,
 * future consumers) that just want the byte-for-byte-identical
 * PATCH with no extra UI side effects.
 */
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  AiSuggestBatchCascade,
  AiSuggestPhaseCascade,
} from "../components/AiSuggestPopover";
import type { Project } from "./types";
import {
  AI_TO_EZ_PHASE,
  EZ_TO_BACKEND_PHASE,
  PHASES,
  computeCascadePatch,
  type PhaseDatePatch,
} from "./phaseCascade";

/**
 * Backend phase-key set. Alias here so consumers don't have to know
 * the underlying literal union — the `_meta.editedPhases` shape is
 * stable across every phase-date PATCH regardless of who dispatches
 * it.
 */
export type AiEditedPhase = "discovery" | "development" | "post_dev";

/**
 * PATCH body shape both the EZEstimates row and the Detail Panel
 * dispatch when accepting a Claude suggestion. `_meta` is the
 * out-of-band provenance envelope the backend consumes to stamp
 * per-phase `_updated_*` audit columns; the shape mirrors the one
 * EZEstimatesView.tsx already sends.
 */
export type AiEstimatePatchBody = PhaseDatePatch & {
  _meta: { source: "user" | "claude"; editedPhases: readonly AiEditedPhase[] };
};

/**
 * Concrete mutation-argument shape. `patchProject` is expected to be
 * a mutation whose `mutationFn` takes exactly this pair — the same
 * shape EZEstimatesView already uses so we can reuse the mutation
 * verbatim if a caller chooses.
 */
export type AiEstimatePatchArgs = {
  projectId: string;
  body: AiEstimatePatchBody;
};

/**
 * TanStack Query mutation type accepted by the factory. Kept loose
 * (`unknown` error, `unknown` context) so callers with more specific
 * onError/onMutate contracts can still pass their mutation in
 * without a cast.
 */
export type AiEstimatePatchMutation = UseMutationResult<
  Project,
  unknown,
  AiEstimatePatchArgs,
  unknown
>;

/**
 * Build the pair of AI accept-handlers for a given project. Both
 * dispatch the same `patchProject` mutation the caller supplies, so
 * cache invalidation + error banner state stay wired to whatever
 * hooks the parent view already has.
 *
 * The optional `onSuccess` fires only on a successful PATCH (i.e.
 * not on a no-op accept where the suggestion matches the persisted
 * dates) and gets the freshly-updated project plus the exact set of
 * phases the PATCH stamped. Currently unused by the Detail Panel;
 * left in the signature so a future violation-toast host doesn't
 * have to re-derive the extract point.
 */
export function makeAiEstimateHandlers({
  project,
  patchProject,
  source,
  onSuccess,
}: {
  project: Project;
  patchProject: AiEstimatePatchMutation;
  source: "user" | "claude";
  onSuccess?: (updated: Project, editedPhases: readonly AiEditedPhase[]) => void;
}): {
  onAcceptPhase: AiSuggestPhaseCascade;
  onAcceptAll: AiSuggestBatchCascade;
} {
  const onAcceptPhase: AiSuggestPhaseCascade = (aiKey, days) => {
    const ezKey = AI_TO_EZ_PHASE[aiKey];
    const phase = PHASES.find((p) => p.key === ezKey);
    if (!phase) return;
    const patch = computeCascadePatch(project, phase.key, days);
    if (Object.keys(patch).length === 0) return;
    const edited: readonly AiEditedPhase[] = [EZ_TO_BACKEND_PHASE[phase.key]];
    patchProject.mutate(
      {
        projectId: project.id,
        body: { ...patch, _meta: { source, editedPhases: edited } },
      },
      onSuccess
        ? { onSuccess: (updated) => onSuccess(updated, edited) }
        : undefined,
    );
  };

  const onAcceptAll: AiSuggestBatchCascade = (phases) => {
    // Thread a "virtual project" through each phase's cascade so the
    // downstream shifts see the previous phase's new dates. Then
    // dispatch ONE atomic PATCH — same rationale as EZEstimates'
    // `makeAiAcceptAllCascade`: three concurrent per-phase mutations
    // race server-side and Post-Dev's non-decreasing-chain check
    // silently rejects the last write.
    let running: Project = project;
    let combined: PhaseDatePatch = {};
    const edited: AiEditedPhase[] = [];
    for (const { phaseKey, days } of phases) {
      const ezKey = AI_TO_EZ_PHASE[phaseKey];
      const patch = computeCascadePatch(running, ezKey, days);
      if (Object.keys(patch).length === 0) continue;
      combined = { ...combined, ...patch };
      running = { ...running, ...patch };
      edited.push(phaseKey);
    }
    if (edited.length === 0) return;
    patchProject.mutate(
      {
        projectId: project.id,
        body: {
          ...combined,
          _meta: { source, editedPhases: edited },
        },
      },
      onSuccess
        ? {
            onSuccess: (updated) => onSuccess(updated, edited),
          }
        : undefined,
    );
  };

  return { onAcceptPhase, onAcceptAll };
}
