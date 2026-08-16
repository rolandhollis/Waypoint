import type { ExposureEvent } from "@ziffsplit/sdk";
import { getOrCreateSubjectId } from "@ziffsplit/sdk";
import { useMockUserStore } from "./mockUser";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

/**
 * Waypoint analytics adapter for ZiffSplit.
 * Persist exposures + named events keyed by ZiffSplit subject id (not login).
 */
async function postAnalytics(path: string, body: unknown): Promise<void> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const mockId = useMockUserStore.getState().mockUserId;
  if (mockId) headers.set("x-mock-user-id", mockId);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (!res.ok) {
      console.warn("[analytics]", path, res.status);
    }
  } catch (err) {
    console.warn("[analytics]", path, err);
  }
}

export function trackExposure(event: ExposureEvent): void {
  const ziffsplitId = event.anonId || getOrCreateSubjectId();
  void postAnalytics("/analytics/exposures", {
    ziffsplitId,
    experimentKey: event.experimentKey,
    variantKey: event.variantKey,
    containerKey: event.containerKey,
    siteKey: event.siteKey,
    configVersion: event.configVersion,
    deliveryMode: event.deliveryMode,
    contentSource: event.contentSource,
    primaryKpi: event.primaryKpi,
    occurredAt: event.timestamp,
  });
}

export function track(
  eventName: string,
  properties?: Record<string, unknown>,
  opts?: { ziffsplitId?: string; occurredAt?: string },
): void {
  const ziffsplitId = opts?.ziffsplitId ?? getOrCreateSubjectId();
  void postAnalytics("/analytics/events", {
    ziffsplitId,
    eventName,
    properties: properties ?? {},
    occurredAt: opts?.occurredAt,
  });
}
