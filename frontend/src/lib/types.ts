export type Role = "admin" | "owner" | "viewer";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatar_url: string | null;
  color: string;
  prefs: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type SwimLane = {
  id: string;
  name: string;
  description: string;
  order: number;
  color: string | null;
  is_terminal: boolean;
  requires_weekly_status: boolean;
  /**
   * Exactly one lane at a time may carry this flag (enforced by a
   * partial unique index). It's where the board's "Add new item"
   * CTA drops newly-created cards.
   */
  is_default_new: boolean;
  /**
   * Optional binding: which phase-date field on a project this lane
   * represents. When set, dragging a card into this lane prompts
   * "want to set <field> to today?" so the PM can stamp real dates
   * without opening the detail panel.
   */
  phase_date_key: PhaseDateKey | null;
  created_at: string;
  updated_at: string;
};

export type PhaseDateKey =
  | "target_date"
  | "dev_start_date"
  | "dev_end_date"
  | "optimization_start_date"
  | "optimization_end_date";

export type Team = {
  id: string;
  name: string;
  color: string;
  order: number;
  created_at: string;
  updated_at: string;
};

export type Project = {
  id: string;
  title: string;
  description: string;
  swim_lane_id: string | null;
  position: number;
  owner_id: string | null;
  /** Team memberships (M:N via `project_teams`). Order is not meaningful. */
  teams: string[];
  tags: string[];
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
  actual_completion_date: string | null;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StatusHistoryEntry = {
  id: string;
  project_id: string;
  from_swim_lane_id: string | null;
  to_swim_lane_id: string | null;
  moved_by_user_id: string | null;
  timestamp: string;
};

export type ProjectComment = {
  id: string;
  project_id: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
};

export type AuditAction = "create" | "edit" | "move" | "archive" | "restore";

/**
 * Row returned by GET /projects/:id/history. Union of the legacy
 * `status_history` (lane moves, `kind: "move"`) and the new
 * `project_audit_events` table (everything else). `field` /
 * `from_value` / `to_value` are populated for `kind: "edit"` (and
 * carry the same triple for `"move"` when the row was written by
 * the /move endpoint). Create / archive / restore leave those null.
 */
export type ProjectTimelineEntry = {
  id: string;
  project_id: string;
  user_id: string | null;
  timestamp: string;
  kind: AuditAction;
  from_swim_lane_id: string | null;
  to_swim_lane_id: string | null;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
};

export type HealthFlag = "white" | "green" | "yellow" | "red";

export type WeeklyStatusUpdate = {
  id: string;
  project_id: string;
  submitted_by_user_id: string | null;
  original_submitted_by_user_id: string | null;
  week_of: string;
  health_flag: HealthFlag;
  executive_summary: string;
  detailed_update: string[];
  completed: boolean;
  due_at: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PendingStatusResponse = {
  week_of: string;
  due_at: string;
  pending: Array<{
    project_id: string;
    existing_update: WeeklyStatusUpdate | null;
  }>;
};

export type StatusReportRow = WeeklyStatusUpdate & {
  project_title: string;
  project_position: number;
  owner_name: string | null;
  team_names: string[];
  swim_lane_id: string | null;
  swim_lane_name: string | null;
  swim_lane_order: number | null;
};

export type StatusReportResponse = {
  week_of: string;
  rows: StatusReportRow[];
};
