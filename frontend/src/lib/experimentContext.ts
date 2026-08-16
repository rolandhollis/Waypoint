import type { AbSdk } from "@ziffsplit/sdk";

/**
 * Build the X-ZiffSplit-Context payload for Waypoint API writes.
 * Host-owned: when VITE_EXPERIMENT_AUDIT_CONTEXT is enabled (default on
 * if a site key is configured), mutating requests stamp current
 * assignments onto project_audit_events.
 */
export function isExperimentAuditContextEnabled(): boolean {
  const flag = import.meta.env.VITE_EXPERIMENT_AUDIT_CONTEXT as string | undefined;
  if (flag != null && flag !== "") {
    return flag.toLowerCase() === "true";
  }
  // Default on when ZiffSplit is configured for this build.
  return Boolean(import.meta.env.VITE_AB_SITE_KEY);
}

export function buildZiffsplitContextHeader(): string | null {
  if (!isExperimentAuditContextEnabled()) return null;
  if (typeof window === "undefined") return null;

  const sdk = (window as Window & { __ziffsplit?: AbSdk }).__ziffsplit;
  if (!sdk?.getSubjectId) return null;

  const assignments: Record<string, string> = {};
  for (const row of sdk.listAssignments()) {
    assignments[row.experimentKey] = row.variantKey;
  }

  return JSON.stringify({
    ziffsplitId: sdk.getSubjectId(),
    assignments,
  });
}
