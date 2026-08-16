import type { ProjectAuditAction } from "../types.js";

export type ParsedEventFilter = {
  action?: ProjectAuditAction;
  field?: string;
  fieldPrefix?: string;
};

const LIFECYCLE_ACTIONS = new Set<ProjectAuditAction>(["create", "move", "archive", "restore", "celebrate"]);

/**
 * Decode the admin audit-trail `event` query param into SQL filters.
 *   move | create | archive | restore — lifecycle / lane move
 *   edit — any field edit
 *   edit:<field> — specific field on project_audit_events
 *   field:deadline | field:dependency | field:link — prefixed fields
 */
export function parseEventFilter(raw?: string): ParsedEventFilter {
  if (!raw?.trim()) return {};
  const event = raw.trim();
  if (event === "edit") return { action: "edit" };
  if (LIFECYCLE_ACTIONS.has(event as ProjectAuditAction)) {
    return { action: event as ProjectAuditAction };
  }
  if (event.startsWith("edit:")) {
    const field = event.slice("edit:".length);
    if (!field) return { action: "edit" };
    return { action: "edit", field };
  }
  if (event.startsWith("field:")) {
    const prefix = event.slice("field:".length);
    if (!prefix) return { action: "edit" };
    return { action: "edit", fieldPrefix: prefix };
  }
  return {};
}
