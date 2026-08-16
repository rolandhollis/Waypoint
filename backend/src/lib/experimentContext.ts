import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

/**
 * Snapshot of ZiffSplit assignments at the time of a mutating request.
 * Stamped onto project_audit_events when EXPERIMENT_AUDIT_CONTEXT=true.
 */
export type ExperimentContext = {
  ziffsplitId: string;
  assignments: Record<string, string>;
};

const schema = z.object({
  ziffsplitId: z.string().min(1).max(200),
  assignments: z.record(z.string().min(1).max(200)).default({}),
});

const storage = new AsyncLocalStorage<ExperimentContext | null>();

export function parseExperimentContextHeader(raw: string | undefined): ExperimentContext | null {
  if (!raw?.trim()) return null;
  try {
    const json = JSON.parse(raw) as unknown;
    const parsed = schema.safeParse(json);
    if (!parsed.success) return null;
    return {
      ziffsplitId: parsed.data.ziffsplitId,
      assignments: parsed.data.assignments,
    };
  } catch {
    return null;
  }
}

export function runWithExperimentContext<T>(ctx: ExperimentContext | null, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getExperimentContext(): ExperimentContext | null {
  return storage.getStore() ?? null;
}
