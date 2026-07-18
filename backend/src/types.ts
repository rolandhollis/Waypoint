export type Role = "admin" | "owner" | "viewer";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  /**
   * @deprecated Per-group role lives in `user_groups.role`; this
   * column is preserved for backwards compat + as the seed source
   * for the RMN backfill migration (017). New code should never
   * read this — use `req.userGroupRole` populated by
   * middleware/auth.ts.
   */
  role: Role;
  avatar_url: string | null;
  color: string;
  prefs: Record<string, unknown>;
  /**
   * Max concurrent active (roadmap-scheduled) projects this user may
   * own before the frontend surfaces a capacity warning. Null = no
   * cap. Default 3, backfilled by migration 015.
   */
  capacity: number | null;
  /**
   * bcrypt hash of the user's login password. NULL means the user
   * has never had a password set (mock-mode users, or a
   * password-mode user that admin created without one yet). Never
   * echoed to the client — see scrubUser() below.
   */
  password_hash: string | null;
  password_updated_at: Date | null;
  /**
   * Multi-tenancy flags added by migration 017.
   *   * is_super_user  — global "manage tenants" capability; the
   *     only account that should ever hold it is the one
   *     bootstrapped from SUPER_ADMIN_EMAIL. Regular admins can't
   *     grant it via the UI.
   *   * current_group_id — which tenant workspace the user is
   *     "in" right now. Persists across sessions/devices; changed
   *     by PATCH /users/me/current-group when they pick a
   *     different one from the navbar dropdown.
   */
  is_super_user: boolean;
  current_group_id: string | null;
  /**
   * Per-user opt-in for outbound reminder emails (weekly status
   * report nudge today; other kinds later). Default true, toggled
   * from the profile dialog or via the one-click unsubscribe link
   * in the email footer.
   */
  email_reminders_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type GroupRow = {
  id: string;
  name: string;
  color: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * One row per (user, group) pair. `role` is the user's role in that
 * specific tenant — a user can be admin in RMN and viewer in VC.
 * See migration 017 for the schema.
 */
export type UserGroupRow = {
  user_id: string;
  group_id: string;
  role: Role;
  created_at: Date;
};

/**
 * Safe-to-return user shape — the exact same fields the frontend
 * expects, minus password_hash. Use scrubUser() before every
 * res.json() that returns a user row so a rogue endpoint can never
 * leak the hash by accident.
 */
export type SafeUserRow = Omit<UserRow, "password_hash">;

export function scrubUser(u: UserRow): SafeUserRow;
export function scrubUser(u: UserRow | null | undefined): SafeUserRow | null;
export function scrubUser(u: UserRow | null | undefined): SafeUserRow | null {
  if (!u) return null;
  const { password_hash: _ph, ...rest } = u;
  return rest;
}

export function scrubUsers(rows: UserRow[]): SafeUserRow[] {
  return rows.map((r) => scrubUser(r));
}

export type SwimLaneRow = {
  id: string;
  /** Tenant scope; every list/create/update filters by this. */
  group_id: string;
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
  /** Tenant scope; every list/create/update filters by this. */
  group_id: string;
  name: string;
  color: string;
  order: number;
  /** Max concurrent active projects for the team; see users.capacity. */
  capacity: number | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type KpiRow = {
  id: string;
  /** Tenant scope; every list/create/update filters by this. */
  group_id: string;
  name: string;
  /** Free-form description surfaced in the KPI report view header. */
  description: string;
  color: string;
  order: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * T-shirt sizing preset used by the EZEstimates view. Fixed
 * cardinality of 5 per tenant (S/M/L/XL/XXL, positions 0..4) — the
 * admin can relabel and re-size, but never add or remove rows. See
 * migration 028 and backend/src/routes/tshirtSizes.ts.
 */
export type TshirtSizeRow = {
  id: string;
  /** Tenant scope; every list/create/update filters by this. */
  group_id: string;
  label: string;
  days: number;
  position: number;
  created_at: Date;
  updated_at: Date;
};

export type ProjectType = "epic" | "subtask";

/**
 * A project row as returned by API queries. `teams` is always populated
 * from the `project_teams` join table via a subquery in the SELECT; it
 * is not a column on the underlying `projects` table.
 */
export type ProjectRow = {
  id: string;
  /** Tenant scope; every list/create/update filters by this. */
  group_id: string;
  title: string;
  description: string;
  swim_lane_id: string | null;
  position: number;
  owner_id: string | null;
  teams: string[];
  tags: string[];
  /**
   * KPI assignments, ordered by per-project position. The order is
   * user-controlled (drag-reorder on the detail panel), so the API
   * always preserves it and the UI can rely on it left-to-right.
   */
  kpis: string[];
  /**
   * Every card is either a top-level epic or a subtask nested under
   * another card (which may itself be a subtask — the tree can be
   * arbitrarily deep). Enforced by CHECK constraints in migration 013:
   * type='epic' ⇒ parent_id NULL; type='subtask' ⇒ parent_id NOT NULL.
   */
  type: ProjectType;
  parent_id: string | null;
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
  actual_completion_date: string | null;
  /**
   * Per-item opt-out from capacity planning. When true, this
   * project is skipped in both the roadmap overload sweep and the
   * auto-scheduler regardless of who owns it. Default false —
   * everything counts by default; toggled by the checkbox in the
   * detail panel / new-item dialog.
   */
  excluded_from_capacity: boolean;
  /**
   * PM flag: has the dev-phase estimate been vetted by an engineer?
   * Default false — old rows carry no confirmation, new rows are
   * created as unconfirmed until a PM flips the checkbox on the
   * detail panel.
   */
  dev_estimate_sourced_by_dev: boolean;
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

/**
 * One deadline row per (project, swim_lane) pair. See
 * migration 018 for the schema.
 *
 * Deadline semantics: the project's phase-date field bound to
 * this swim lane (swim_lanes.phase_date_key) must be on or before
 * `deadline_date`. If phase_date_key is null (admin unset the
 * binding after the deadline was created), the deadline still
 * exists but violations aren't computed against it.
 */
export type ProjectDeadlineRow = {
  id: string;
  project_id: string;
  swim_lane_id: string;
  deadline_date: string; // ISO date (YYYY-MM-DD)
  note: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * One dependency row per (dependent project's phase → upstream
 * project's phase). See migration 019.
 *
 * Semantics: `project_id`'s `project_swim_lane_id` phase START
 * cannot begin until `depends_on_project_id`'s
 * `depends_on_swim_lane_id` phase END has completed.
 *
 * The two lanes needn't be the same; e.g. X's In-Dev can depend on
 * Y's Complete. Both lanes must have `phase_date_key` bound so the
 * client-side violation calculator has both dates to compare.
 *
 * Cross-tenant deps are rejected at the route layer — all four ids
 * must resolve inside the caller's current group.
 */
export type ProjectDependencyRow = {
  id: string;
  project_id: string;
  project_swim_lane_id: string;
  depends_on_project_id: string;
  depends_on_swim_lane_id: string;
  note: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * External-URL link attached to a project (Jira ticket, Confluence
 * page, Figma, etc.). See migration 027.
 *
 * `label` is denormalized per-link — no separate label catalog
 * table. The "known labels" list surfaced to the frontend's picker
 * is derived at query time from DISTINCT labels within the caller's
 * group.
 *
 * `position` is a per-project sequence; reorder is a full-replace
 * on the client side (no drag UI shipped yet, but the column is
 * here to avoid a follow-up migration).
 */
export type ProjectLinkRow = {
  id: string;
  project_id: string;
  label: string;
  url: string;
  position: number;
  created_at: Date;
  updated_at: Date;
};

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
