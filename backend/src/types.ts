export type Role = "admin" | "owner" | "viewer";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatar_url: string | null;
  color: string;
  prefs: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type SwimLaneRow = {
  id: string;
  name: string;
  description: string;
  order: number;
  color: string | null;
  is_terminal: boolean;
  requires_weekly_status: boolean;
  /**
   * Exactly one lane at a time may carry this flag (partial unique
   * index in migration 007). It is where the board's "Add new item"
   * CTA drops freshly-created cards.
   */
  is_default_new: boolean;
  /**
   * Optional: which phase-date field this lane represents. When set,
   * dragging a card into this lane prompts the PM to stamp the
   * corresponding date. See migration 011 for the allowed values.
   */
  phase_date_key: PhaseDateKey | null;
  /**
   * Hides the lane (and any project living in it) from non-admin API
   * responses. Any lane can be marked; typical use is the Archive
   * lane, but experimental/scratch lanes work too. See migration 012.
   */
  is_admin_only: boolean;
  /**
   * Exactly one lane at a time may carry this flag (partial unique
   * index). It is the destination of the "Move to archive" button on
   * the project detail panel; the backend resolves it server-side so
   * non-admins can archive without ever holding the lane's id.
   */
  is_archive: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type PhaseDateKey =
  | "target_date"
  | "dev_start_date"
  | "dev_end_date"
  | "optimization_start_date"
  | "optimization_end_date";

export type TeamRow = {
  id: string;
  name: string;
  color: string;
  order: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * A project row as returned by API queries. `teams` is always populated
 * from the `project_teams` join table via a subquery in the SELECT; it
 * is not a column on the underlying `projects` table.
 */
export type ProjectRow = {
  id: string;
  title: string;
  description: string;
  swim_lane_id: string | null;
  position: number;
  owner_id: string | null;
  teams: string[];
  tags: string[];
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
  actual_completion_date: string | null;
  deleted_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type StatusHistoryRow = {
  id: string;
  project_id: string;
  from_swim_lane_id: string | null;
  to_swim_lane_id: string | null;
  moved_by_user_id: string | null;
  timestamp: Date;
};

export type ProjectCommentRow = {
  id: string;
  project_id: string;
  author_user_id: string | null;
  body: string;
  created_at: Date;
  updated_at: Date;
};

export type ProjectAuditAction = "create" | "edit" | "move" | "archive" | "restore";

export type ProjectAuditRow = {
  id: string;
  project_id: string;
  user_id: string | null;
  action: ProjectAuditAction;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
  timestamp: Date;
};

/**
 * Normalized "one thing happened to this project" record returned by
 * `/projects/:id/history`. Discriminated by `kind` because it merges
 * two underlying tables — `status_history` (lane movements, kind =
 * "move") and `project_audit_events` (everything else). Frontend
 * renders both under a single audit-trail list.
 */
export type TimelineEntryRow = {
  id: string;
  project_id: string;
  user_id: string | null;
  timestamp: Date;
  kind: "move" | ProjectAuditAction;
  from_swim_lane_id: string | null;
  to_swim_lane_id: string | null;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
};

export type HealthFlag = "white" | "green" | "yellow" | "red";

export type WeeklyStatusUpdateRow = {
  id: string;
  project_id: string;
  submitted_by_user_id: string | null;
  original_submitted_by_user_id: string | null;
  week_of: string;
  health_flag: HealthFlag;
  executive_summary: string;
  detailed_update: string[];
  completed: boolean;
  due_at: Date;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
