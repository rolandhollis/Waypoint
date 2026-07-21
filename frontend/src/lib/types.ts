export type Role = "admin" | "owner" | "viewer";

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatar_url: string | null;
  color: string;
  prefs: Record<string, unknown>;
  /**
   * Soft cap on the number of concurrent active (roadmap-scheduled)
   * projects this user can own. Null = no cap. Enforced only by
   * client-side warnings — the backend never blocks a save on this.
   */
  capacity: number | null;
  /**
   * When the user's password was last set/reset. Null means the
   * user has never had a password (mock-mode users, or a
   * password-mode account admin hasn't finished provisioning). UI
   * uses this to badge "No password" rows. The plaintext + hash
   * are never sent to the client.
   */
  password_updated_at: string | null;
  /**
   * Global "manage tenants" capability. Distinct from role — role
   * lives per-group (see `memberships`), while is_super_user is
   * either true (bootstrap super-admin) or false (everyone else).
   */
  is_super_user: boolean;
  /**
   * The group the user is currently "in". All group-scoped API
   * calls filter server-side against this id; changing groups is
   * done via a PATCH /users/me/current-group.
   */
  current_group_id: string | null;
  /**
   * Populated by GET /users/me. One entry per (user, group) pair
   * with the caller's role in that specific tenant. Super-users
   * see one entry per group in the system even without explicit
   * enrollment.
   */
  memberships?: GroupMembership[];
  /**
   * Personal opt-in for reminder emails (weekly status report
   * today, other kinds later). Default true; toggled from the
   * profile dialog or via the one-click unsubscribe link in the
   * email footer.
   */
  email_reminders_enabled: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * A single tenant workspace ("brand"). Every project, swim lane,
 * team, and KPI belongs to exactly one group.
 */
export type Group = {
  id: string;
  name: string;
  color: string | null;
  created_by: string | null;
  /**
   * Admin-editable runtime "constants" for this tenant. See
   * `AppConstants` — today only `app_name` is recognized, more keys
   * will accrete over time. Always present (`{}` when the admin
   * hasn't customized anything) so consumers never have to check
   * whether the bag itself exists.
   */
  constants: AppConstants;
  created_at: string;
  updated_at: string;
};

/**
 * Stable-shape mirror of the backend `AppConstants` type. Every
 * key is optional; a `null` value means "admin explicitly cleared
 * this back to the built-in default" and undefined means "never
 * set". Consumers treat both the same way — fall back to the
 * hardcoded default (e.g. "Waypoint" for `app_name`).
 */
export type AppConstants = {
  /** Tenant-visible product name shown in navbar / document title. */
  app_name?: string | null;
};

/**
 * The user's role in a specific group. Returned inline in the
 * /users/me response so the navbar can render the group switcher
 * without a second round trip.
 */
export type GroupMembership = {
  group_id: string;
  role: Role;
  name: string;
  color: string | null;
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
  /**
   * Hidden from non-admin users. The backend filters these lanes (and
   * any project living in them) out of every non-admin API response;
   * clients will simply never see them for a viewer/owner. Admins get
   * full visibility and can manage the flag from Admin → Swim lanes.
   */
  is_admin_only: boolean;
  /**
   * Exactly one lane at a time carries this flag. It is the target
   * of the "Move to archive" button on the project detail panel; the
   * backend resolves it server-side so non-admins can still archive
   * even though they can't see the lane.
   */
  is_archive: boolean;
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
  /** See User.capacity — same semantics, applied to team membership. */
  capacity: number | null;
  created_at: string;
  updated_at: string;
};

export type Kpi = {
  id: string;
  name: string;
  description: string;
  color: string;
  order: number;
  created_at: string;
  updated_at: string;
};

/**
 * Curated "gold-standard" reference estimate used to seed the AI
 * suggester's few-shot pool. Distinct from a real project — admins
 * upload / hand-enter these to teach Claude what a good estimate
 * looks like for this tenant. Backend: migration 031 +
 * routes/aiReferenceEstimates.ts. At least one of the three
 * *_days fields is guaranteed non-null (CHECK constraint).
 */
export type AiReferenceEstimate = {
  id: string;
  title: string;
  description: string;
  discovery_days: number | null;
  development_days: number | null;
  post_dev_days: number | null;
  notes: string | null;
  source_label: string | null;
  position: number;
  created_at: string;
  created_by: string | null;
};

/**
 * T-shirt sizing preset used by the EZEstimates view. Fixed
 * cardinality of 5 rows per tenant (S/M/L/XL/XXL) — admins can
 * relabel and re-size but cannot add or remove rows. See migration
 * 028 and backend/src/routes/tshirtSizes.ts for the source of
 * truth.
 */
export type TshirtSize = {
  id: string;
  label: string;
  days: number;
  position: number;
  created_at: string;
  updated_at: string;
};

export type ProjectType = "epic" | "subtask";

/**
 * A promise that a specific phase of the project (bound via the
 * swim lane's `phase_date_key`) will finish no later than
 * `deadline_date`. Nested inside `Project.deadlines` and edited
 * via /api/projects/:id/deadlines. See migration 018 for the
 * schema and `lib/deadlines.ts` for the client-side violation
 * calculation.
 */
export type ProjectDeadline = {
  id: string;
  swim_lane_id: string;
  deadline_date: string;
  note: string;
};

/**
 * A dependency links THIS project's phase START (identified by
 * `project_swim_lane_id`) to another project's phase END
 * (identified by `depends_on_project_id` + `depends_on_swim_lane_id`).
 * Multiple deps per project + per lane are allowed. See
 * `lib/dependencies.ts` for the violation calculator.
 */
export type ProjectDependency = {
  id: string;
  project_swim_lane_id: string;
  depends_on_project_id: string;
  depends_on_swim_lane_id: string;
  note: string;
};

/**
 * External-URL "link" attached to a project (Jira ticket, Confluence
 * page, Figma, etc.). See migration 027.
 *
 * `label` is stored per-link as a plain string; there's no shared
 * catalog table. The link-label picker sources its suggestions
 * from `GET /links/label-suggestions` (DISTINCT labels across the
 * caller's group) unioned with the built-in defaults
 * (`Jira`, `Confluence`) — see `useLinkLabelSuggestions`.
 *
 * `position` is present so a future drag-reorder UI can land as a
 * full-replace without a migration; no reorder affordance ships yet.
 */
export type ProjectLink = {
  id: string;
  project_id: string;
  label: string;
  url: string;
  position: number;
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
  /**
   * Ordered team memberships (M:N via `project_teams`). Order IS
   * meaningful — PMs rank the contributing teams primary → secondary
   * → tertiary on the detail panel, and every downstream renderer
   * (Board card chips, Roadmap accent, KPI report row, Sort modal,
   * status report row) mirrors that order. Backend preserves it via
   * a `position` column on the join, same shape as `project_kpis`.
   */
  teams: string[];
  tags: string[];
  /**
   * Ordered KPI assignments (M:N via `project_kpis`). Order IS
   * meaningful — PMs rank KPIs by importance on their project. Backend
   * preserves the order via a `position` column; frontend renders
   * left-to-right and offers drag-reorder on the detail panel.
   */
  kpis: string[];
  /**
   * Every project is either an epic (top-level) or a subtask (nested
   * under a parent, potentially many layers deep). Backend enforces
   * that epic implies parent_id=null and subtask implies parent_id!=null.
   */
  type: ProjectType;
  parent_id: string | null;
  /**
   * Hard deadlines pinned to individual swim-lane phases. At most
   * one per (project, swim_lane) pair. See lib/deadlines.ts for the
   * violation calculator used by the detail panel + roadmap.
   */
  deadlines: ProjectDeadline[];
  /**
   * Cross-project blockers. This project's phase start (identified
   * by project_swim_lane_id) must not begin before the upstream
   * project's phase end. See lib/dependencies.ts for status logic.
   */
  dependencies: ProjectDependency[];
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
  actual_completion_date: string | null;
  /**
   * Per-item opt-out from capacity planning. When true this row is
   * skipped in both the roadmap overload sweep and the
   * auto-scheduler; the bar still draws on the roadmap so viewers
   * can still see the scheduled work. Controlled by the checkbox
   * in the detail panel / new-item dialog.
   */
  excluded_from_capacity: boolean;
  /**
   * Persistent per-project auto-scheduler lock (migration 034).
   * When true, the Auto-schedule modal pre-checks this project as
   * locked-permanent and refuses to let the user unlock it from
   * the picker; the toggle only lives on the padlock icon in the
   * ProjectDetailPanel header. Manual date edits (detail panel,
   * EZEstimates picker) are unaffected — this flag only gates the
   * automated Auto-schedule flow.
   */
  dates_locked: boolean;
  /**
   * Per-project "hide from the Roadmap view" flag (migration 035).
   * When true the project is unconditionally excluded from the
   * Roadmap view — no filter, timeframe, group-by, sort order, or
   * PDF export brings it back. Every other view (Board, Status
   * Report, EZEstimates, admin lists) still shows the item. Toggled
   * from the checkbox in the ProjectDetailPanel's Timelines &
   * Estimates section.
   */
  hidden_from_roadmap: boolean;
  /**
   * PM flag: has an engineer signed off on the dev-phase estimate?
   * Default false — new rows are provisional until dev confirms.
   * When false, the roadmap draws the dev bar segment with a
   * distinctive dashed outline so viewers can tell at a glance
   * which parts of the timeline are still best-guesses.
   */
  dev_estimate_sourced_by_dev: boolean;
  /**
   * Per-phase estimate provenance columns added by migration 032.
   * Populated whenever the phase's date pair actually moved on a
   * write; NULL until the first update after the migration lands.
   *
   * `_source` is one of the values in `EstimateSource` — the CHECK
   * constraint on the column encodes the same set. `'cascade'` is
   * only ever set by the server (never accepted from the wire) and
   * flags a phase that was shifted by an upstream pick rather than
   * directly edited.
   *
   * The EZEstimates row uses the max of the three `_updated_at`
   * values to render a "Updated <date> · <source>" chip; the
   * detail-panel audit trail continues to source per-field history
   * from `project_audit_events`, so these columns are UI hints
   * only, not the source of truth for what changed.
   */
  discovery_updated_at: string | null;
  discovery_updated_by_user_id: string | null;
  discovery_updated_source: EstimateSource | null;
  development_updated_at: string | null;
  development_updated_by_user_id: string | null;
  development_updated_source: EstimateSource | null;
  post_dev_updated_at: string | null;
  post_dev_updated_by_user_id: string | null;
  post_dev_updated_source: EstimateSource | null;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Allowed values for `<phase>_updated_source`. Mirrors the CHECK
 * constraint in migration 032 (backend/src/db/migrations/032_*).
 * `'cascade'` is only ever authored server-side — the router
 * derives it when an upstream phase-date pick implicitly shifted
 * this phase's dates.
 */
export type EstimateSource = "user" | "claude" | "csv" | "cascade";

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

/**
 * One row of the Roadmap's "Recent changes" feed. Backed by
 * GET /projects/audit/recent — a flat, tenant-wide list of the last
 * N days of project mutations. `kind` discriminates the source table
 * so the shared audit renderer can pick between "lane move" (from
 * status_history) and "field edit" (from project_audit_events).
 *
 * `root_epic_id` is the top-most ancestor reachable from the changed
 * project via the parent_id chain at query time — used by the client
 * to group entries by root epic without re-walking the hierarchy.
 * Standalone projects (no parent) are their own root.
 *
 * `in_archive` is TRUE when the project currently sits in a lane
 * flagged is_archive; the UI chips those entries so viewers know
 * why the corresponding card no longer appears on the roadmap.
 */
export type RecentAuditEvent = {
  id: string;
  kind: "audit" | "move";
  project_id: string;
  project_title: string;
  project_type: ProjectType;
  root_epic_id: string;
  root_epic_title: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
  occurred_at: string;
  in_archive: boolean;
};

export type RecentAuditEventsResponse = {
  events: RecentAuditEvent[];
  days: number;
  truncated: boolean;
};

/**
 * One-phase slice of a Claude-generated AI suggestion. The `size`
 * is a T-shirt catalog label (whatever the admin has renamed the
 * bucket to — never hard-code S/M/L/XL/XXL); `confidence` is
 * always one of low/medium/high; `reasoning` is a short (~1–2
 * sentences) natural-language justification that references the
 * historical evidence the model weighed.
 */
export type AiPhaseSuggestion = {
  size: string;
  confidence: "low" | "medium" | "high";
  reasoning: string;
};

/**
 * Full response persisted at `projects.ai_suggestion`. Includes
 * token counts so a future admin dashboard can surface spend, and
 * the model slug so a re-run after ANTHROPIC_MODEL was rotated is
 * still identifiable in the audit trail.
 *
 * The three phase keys match the estimator module's PhaseKey enum:
 * `discovery`, `development`, `post_dev`. The EZEstimates popover
 * maps them onto the same phase definitions the cascade helper
 * uses (see `EZEstimatesView.tsx`).
 */
export type AiSuggestion = {
  discovery: AiPhaseSuggestion;
  development: AiPhaseSuggestion;
  post_dev: AiPhaseSuggestion;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
};

/**
 * Response shape from GET /projects/:id/ai-estimate. `cached: true`
 * with a null `suggestion` means the project has never had a
 * suggestion generated — the frontend renders that as a plain
 * "click Suggest" prompt. When populated, `generated_at` is the
 * timestamp on `projects.ai_suggested_at` so the popover can show
 * "generated {time-ago}".
 */
export type AiSuggestionCached = {
  suggestion: AiSuggestion | null;
  cached: true;
  generated_at: string | null;
};

/**
 * Response shape from POST /projects/:id/ai-estimate on success.
 * `cached: false` marks the freshly-generated payload so the popover
 * can drop the "generated {time-ago}" line for the newly-computed
 * answer.
 */
export type AiSuggestionFresh = {
  suggestion: AiSuggestion;
  cached: false;
};

/**
 * Response shape from GET /projects/ai-estimator/health. `configured`
 * is true when ANTHROPIC_API_KEY is set on the server. The endpoint
 * never contacts Anthropic itself, so this is a cheap admin-page ping.
 */
export type AiEstimatorHealth = {
  configured: boolean;
  model: string | null;
};

/**
 * Per-project payload the client packages up for the AI Roadmap
 * Headline request. Descriptions are truncated on the server side
 * to bound token cost — this type carries whatever the client is
 * willing to send.
 */
export type AiHeadlineProjectPayload = {
  title: string;
  description: string;
  start: string | null;
  end: string | null;
  phase: string;
  teamNames: string[];
  ownerName: string | null;
  kpiNames: string[];
};

/**
 * One pre-grouped section of the roadmap the client asks Claude to
 * summarize. `label` is the group heading (e.g. "Loyalty" for a
 * team, "Discovery" for a swim lane). `projects` is the ordered
 * list of items within it.
 */
export type AiHeadlineGroupPayload = {
  label: string;
  projects: AiHeadlineProjectPayload[];
};

/**
 * Request body sent to POST /api/ai/roadmap-headline. The client
 * pre-computes `fingerprint` from the current filter/timeframe/
 * group state + visible project ids so the response can be cached
 * on the browser without a second fingerprint round-trip.
 */
export type AiHeadlineRequestBody = {
  fingerprint: string;
  groupBy: "none" | "lane" | "team" | "owner" | "kpi" | "tag";
  timeframeLabel: string;
  groups: AiHeadlineGroupPayload[];
};

/**
 * Response shape from POST /api/ai/roadmap-headline. `fingerprint`
 * echoes the request so the client can cheaply confirm the reply
 * matches the view state it was asked about. `headline` is
 * multi-paragraph markdown (or plain-text with double-newline
 * paragraph breaks); `## <group label>` headers separate sections.
 * `model` + `generatedAt` back the popover-style footer the UI
 * renders below the summary.
 */
export type AiHeadlineResponse = {
  fingerprint: string;
  headline: string;
  model: string;
  generatedAt: string;
};

/**
 * Cached headline entry stored in zustand keyed by tenant. Every
 * field is populated together — the entire object is written on
 * success and cleared on regenerate.
 */
export type RoadmapHeadlineCacheEntry = {
  fingerprint: string;
  headline: string;
  model: string;
  generatedAt: string;
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
