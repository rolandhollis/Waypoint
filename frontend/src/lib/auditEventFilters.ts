import { FIELD_LABELS } from "./auditRender";

/**
 * Values for the admin audit-trail Event filter. Encoded as a single
 * query param (`event`) — see backend parseEventFilter().
 */
export const AUDIT_EVENT_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All events" },
  { value: "move", label: "Lane move" },
  { value: "create", label: "Created" },
  { value: "archive", label: "Archived" },
  { value: "restore", label: "Restored" },
  { value: "edit", label: "Any edit" },
  { value: "field:deadline", label: "Deadline updated" },
  { value: "field:dependency", label: "Dependency updated" },
  { value: "field:link", label: "Link updated" },
  ...Object.entries(FIELD_LABELS)
    .map(([field, label]) => ({
      value: `edit:${field}`,
      label: `Edited ${label}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];
