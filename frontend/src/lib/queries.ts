import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type {
  AiEstimatorHealth,
  AiReferenceEstimate,
  AiSuggestionCached,
  AppConstants,
  Group,
  Kpi,
  PendingStatusResponse,
  Project,
  ProjectComment,
  ProjectLink,
  ProjectTimelineEntry,
  RecentAuditEventsResponse,
  Role,
  StatusReportResponse,
  SwimLane,
  Team,
  TshirtSize,
  User,
  WeeklyStatusUpdate,
} from "./types";

const POLL_MS = 5_000;

export type AuthMode = "mock" | "password" | "okta" | "cloudflare-access";
export type HealthResponse = { ok: boolean; auth: AuthMode };

/** Cheap unauthenticated ping so the shell can pick the right login flow. */
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api<HealthResponse>("/health"),
    staleTime: Infinity,
    retry: 1,
  });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<User>("/users/me"),
    staleTime: 30_000,
    // Suppress the auto-retry on 401 — the ApiError sink already
    // handles session expiry by redirecting to the login screen, and
    // retrying just delays that transition.
    retry: (failureCount, error) => {
      if (error && (error as { status?: number }).status === 401) return false;
      return failureCount < 2;
    },
    enabled,
  });
}

/**
 * Effective role for the caller in whichever group they're
 * currently "in". Falls back to the deprecated global role for
 * pre-migration users, matching the backend's requireRole()
 * fallback in middleware/auth.ts.
 *
 * Returns null while /users/me is still loading; callers should
 * treat that as "assume viewer" until it resolves.
 */
export function useCurrentGroupRole(): Role | null {
  const me = useMe();
  if (!me.data) return null;
  const currentId = me.data.current_group_id;
  const membership = me.data.memberships?.find((m) => m.group_id === currentId);
  return membership?.role ?? me.data.role ?? null;
}

/** Convenience wrappers used by nav gating + write buttons. */
export function useIsAdmin(): boolean {
  return useCurrentGroupRole() === "admin";
}

/**
 * True if the caller can write in the currently-active group.
 * Owners + admins can write; viewers can't. Used to gate mutation
 * buttons across the board / roadmap / project detail panel etc.
 */
export function useCanWrite(): boolean {
  const role = useCurrentGroupRole();
  return role === "admin" || role === "owner";
}

/** Global "manage tenants" capability — unlocks the Groups admin section. */
export function useIsSuperUser(): boolean {
  const me = useMe();
  return !!me.data?.is_super_user;
}

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => api<User[]>("/users"),
    enabled,
  });
}

/**
 * The set of groups a specific user belongs to, one row per
 * membership with the per-group role and group metadata. Used by
 * the user-detail modal to render the checkbox editor.
 * Super-users come back as implicit members of every group
 * (`implicit: true`), which the UI renders as disabled-and-checked.
 */
export type UserGroupMembership = {
  group_id: string;
  group_name: string;
  group_color: string | null;
  role: Role;
  implicit: boolean;
};
export function useUserGroups(userId: string | null) {
  return useQuery({
    queryKey: ["userGroups", userId],
    queryFn: () => api<UserGroupMembership[]>(`/users/${userId}/groups`),
    enabled: !!userId,
  });
}

/**
 * Users who exist in the DB but have zero group memberships. Used
 * by the "Unassigned users" section on the Users admin tab so a
 * PM can rescue an orphaned account that would otherwise be
 * invisible to every group (yet still hold its email address
 * against re-creation).
 */
export function useUnassignedUsers(enabled = true) {
  return useQuery({
    queryKey: ["unassignedUsers"],
    queryFn: () => api<User[]>("/users/unassigned"),
    enabled,
  });
}

export function useMockRoster(enabled = true) {
  return useQuery({
    queryKey: ["mockRoster"],
    queryFn: () => api<User[]>("/users/mock-roster"),
    staleTime: Infinity,
    enabled,
  });
}

export function useSwimLanes() {
  return useQuery({
    queryKey: ["swimLanes"],
    queryFn: () => api<SwimLane[]>("/swim-lanes"),
    refetchInterval: POLL_MS,
  });
}

export function useTeams() {
  return useQuery({
    queryKey: ["teams"],
    queryFn: () => api<Team[]>("/teams"),
    refetchInterval: POLL_MS,
  });
}

export function useKpis() {
  return useQuery({
    queryKey: ["kpis"],
    queryFn: () => api<Kpi[]>("/kpis"),
    refetchInterval: POLL_MS,
  });
}

/**
 * T-shirt size presets for the caller's current group. Ordered by
 * position (0..4 → S/M/L/XL/XXL by default). Consumed by the
 * EZEstimates size picker and the Admin → T-Shirt Sizes tab. Polls
 * on the standard cadence so a relabel/re-size in another admin's
 * tab shows up in the picker within a few seconds.
 */
export function useTshirtSizes() {
  return useQuery({
    queryKey: ["tshirtSizes"],
    queryFn: () => api<TshirtSize[]>("/tshirt-sizes"),
    refetchInterval: POLL_MS,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
    refetchInterval: POLL_MS,
  });
}

/**
 * Ranked list of every roadmap-eligible project in the current
 * group, sorted `(global_priority ASC, updated_at DESC, id ASC)`.
 * Backs the Prioritization tab; see backend/src/routes/prioritization.ts
 * for the eligibility predicate.
 *
 * Poll cadence matches the Board / Roadmap so a concurrent edit
 * in another tab flows into the drag surface within a few seconds.
 * A drag-triggered PUT invalidates this key optimistically before
 * the server round-trip so the local list moves immediately.
 */
export type PrioritizationRow = {
  id: string;
  title: string;
  description: string;
  team_ids: string[];
  team_names: string[];
  start_date: string;
  optimization_end_date: string;
  swim_lane_id: string | null;
  global_priority: number;
  position: number;
  is_key_strategic: boolean;
};

/**
 * Server envelope for GET /api/prioritization. The `version` string
 * is a SHA-1 fingerprint of the full eligible `(id, global_priority)`
 * set at read time and MUST be echoed back verbatim as
 * `expected_version` on the next PUT — a mismatch yields a 409
 * (`STALE_PRIORITY_VERSION`) so the writer refetches instead of
 * silently overwriting a concurrent PM's rank change.
 */
type PrioritizationEnvelope = {
  rows: PrioritizationRow[];
  version: string;
};

/**
 * Options for `usePrioritization`.
 *   * `pausePoll` — when true, disables the background refetch
 *     cadence. Used by the Prioritization drag surface to freeze
 *     the poll while a drag is in flight so a mid-drag refetch
 *     can't clobber the local optimistic order or reset the
 *     cached `expected_version` under the user's cursor.
 */
export type UsePrioritizationOptions = {
  enabled?: boolean;
  pausePoll?: boolean;
};

/**
 * Ranked list plus its server-side version fingerprint. The hook
 * unwraps the server envelope so `.data` still resolves to
 * `PrioritizationRow[] | undefined` — matching the pre-envelope
 * shape so existing readers (`prioritization.data`) don't need to
 * change. `.version` is the companion field the reorder writer
 * echoes back as `expected_version`; it's undefined until the first
 * successful fetch, at which point every render sees the latest
 * server fingerprint (react-query keeps the returned object stable
 * between renders when the envelope hasn't changed).
 */
export function usePrioritization(
  optsOrEnabled: UsePrioritizationOptions | boolean = true,
) {
  const opts: UsePrioritizationOptions =
    typeof optsOrEnabled === "boolean" ? { enabled: optsOrEnabled } : optsOrEnabled;
  const enabled = opts.enabled ?? true;
  const pausePoll = opts.pausePoll ?? false;
  const q = useQuery({
    queryKey: ["prioritization"],
    queryFn: () => api<PrioritizationEnvelope>("/prioritization"),
    // Pause polling while a drag is in flight so a background
    // refetch can't reset the cached list (or its `version`) mid-
    // gesture. When `pausePoll` is false we fall back to the shared
    // POLL_MS cadence used by the Board/Roadmap.
    refetchInterval: pausePoll ? false : POLL_MS,
    enabled,
  });
  return {
    ...q,
    data: q.data?.rows,
    version: q.data?.version,
  } as Omit<typeof q, "data"> & {
    data: PrioritizationRow[] | undefined;
    version: string | undefined;
  };
}

export function useProjectHistory(id: string) {
  return useQuery({
    queryKey: ["projectHistory", id],
    queryFn: () => api<ProjectTimelineEntry[]>(`/projects/${id}/history`),
    enabled: !!id,
  });
}

/**
 * Tenant-wide "what changed recently" feed, driving the Roadmap's
 * Recent-changes section. Polls on the shared cadence (POLL_MS) so
 * a change made in another user's session shows up here within a
 * few seconds — same rhythm the Roadmap's projects / lanes / teams
 * queries already use.
 *
 * `days` is passed through to the server and capped there (1..30).
 */
export function useRecentAuditEvents(days = 7) {
  return useQuery({
    queryKey: ["recentAuditEvents", days],
    queryFn: () => api<RecentAuditEventsResponse>(`/projects/audit/recent?days=${days}`),
    refetchInterval: POLL_MS,
  });
}

export function useProjectStatusUpdates(id: string) {
  return useQuery({
    queryKey: ["projectStatusUpdates", id],
    queryFn: () => api<WeeklyStatusUpdate[]>(`/projects/${id}/status-updates`),
    enabled: !!id,
  });
}

/**
 * External-URL links attached to a project (Jira, Confluence, etc.).
 * Backed by GET /projects/:id/links; mutations
 * (POST/PATCH/DELETE) invalidate this key + projectHistory so the
 * audit trail stays in sync.
 */
export function useProjectLinks(id: string) {
  return useQuery({
    queryKey: ["projectLinks", id],
    queryFn: () => api<ProjectLink[]>(`/projects/${id}/links`),
    enabled: !!id,
  });
}

/**
 * DISTINCT labels across every link in the caller's current group.
 * Feeds the link-label combobox; the frontend unions this list with
 * the built-in defaults (`Jira`, `Confluence`) so both surface even
 * before any link has been created in the tenant.
 */
export function useLinkLabelSuggestions() {
  return useQuery({
    queryKey: ["linkLabelSuggestions"],
    queryFn: () => api<{ labels: string[] }>("/links/label-suggestions"),
    staleTime: 30_000,
  });
}

export function useProjectComments(id: string) {
  return useQuery({
    queryKey: ["projectComments", id],
    queryFn: () => api<ProjectComment[]>(`/projects/${id}/comments`),
    enabled: !!id,
    refetchInterval: POLL_MS,
  });
}

export function usePendingStatus() {
  return useQuery({
    queryKey: ["pendingStatus"],
    queryFn: () => api<PendingStatusResponse>("/status-updates/pending?user_id=me"),
    refetchInterval: 15_000,
  });
}

export function useStatusReport(weekOf?: string) {
  const qs = weekOf ? `?week_of=${weekOf}` : "";
  return useQuery({
    queryKey: ["statusReport", weekOf ?? "current"],
    queryFn: () => api<StatusReportResponse>(`/status-updates/report${qs}`),
    refetchInterval: POLL_MS,
  });
}

/**
 * Groups the caller can see. Super-users see every group in the
 * system; regular users see just the ones they're members of.
 * Used by the admin Groups tab, not the navbar switcher — the
 * switcher reads from `useMe().memberships` so it doesn't need a
 * second request to render.
 */
export function useGroups(enabled = true) {
  return useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Group[]>("/groups"),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Members of a specific group with per-user role. Only fetched
 * when the admin opens a group's membership row.
 */
export type GroupMemberRow = {
  user_id: string;
  role: Role;
  name: string;
  email: string;
};

export function useGroupMembers(groupId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["groupMembers", groupId],
    queryFn: () => api<GroupMemberRow[]>(`/groups/${groupId}/members`),
    enabled: enabled && !!groupId,
    staleTime: 30_000,
  });
}

/**
 * Cached AI phase-size suggestion for a project. Backs the
 * EZEstimates popover — reads the last-persisted response without
 * spending a Claude token, so viewers see whatever the last writer
 * generated. Enabled lazily (only when a caller passes a real
 * project id) so we don't hammer the endpoint from the whole
 * EZEstimates list.
 *
 * The endpoint always resolves to a `cached: true` envelope; the
 * `suggestion` field is null when the project has never been
 * estimated. Mutations to POST /projects/:id/ai-estimate should
 * invalidate `["aiSuggestion", id]` on success so the popover
 * transitions from stale to fresh without a manual refetch.
 */
export function useAiSuggestion(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["aiSuggestion", projectId],
    queryFn: () => api<AiSuggestionCached>(`/projects/${projectId}/ai-estimate`),
    enabled: enabled && !!projectId,
    // Cached suggestions don't invalidate on their own; the user
    // clicks Regenerate when they want a new one. Long staleTime
    // avoids background refetches for a resource that only changes
    // in response to explicit user action.
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Feature-flag ping: does the deploy have ANTHROPIC_API_KEY set?
 * Used by the Admin → Notifications tab to render a one-line
 * status row. Cheap — never contacts Anthropic. Stale for a full
 * minute since a Fly secret rotation is an operator action, not
 * a live user preference.
 */
export function useAiEstimatorHealth(enabled = true) {
  return useQuery({
    queryKey: ["aiEstimatorHealth"],
    queryFn: () => api<AiEstimatorHealth>("/projects/ai-estimator/health"),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Curated AI reference estimates for the caller's current tenant,
 * ordered by admin-assigned `position`. Feeds the AI reference
 * estimates admin tab; the same rows are pulled server-side by the
 * suggester's few-shot loader (see backend/src/routes/projects.ts).
 * Standard poll cadence so a curator's edit in another tab shows
 * up here within a few seconds.
 */
export function useAiReferenceEstimates(enabled = true) {
  return useQuery({
    queryKey: ["aiReferenceEstimates"],
    queryFn: () => api<AiReferenceEstimate[]>("/ai-reference-estimates"),
    enabled,
    refetchInterval: POLL_MS,
  });
}

/**
 * Built-in fallback name shown when the current group has no
 * `app_name` constant set (or when there is no current group at
 * all, e.g. on the pre-auth login screen). Kept as an exported
 * constant so the Constants admin form can render it as the input
 * placeholder without duplicating the literal.
 */
export const DEFAULT_APP_NAME = "Waypoint";

/**
 * The Group row (from `useGroups`) matching the user's current
 * tenant, or `null` while `useMe` / `useGroups` are still loading
 * or the user has no active group (pre-auth, or an admin-just-
 * removed-them edge case that `useMe` will recover from on the
 * next refetch).
 *
 * Deliberately reads from `useGroups()` rather than
 * `useMe().memberships` because memberships carry only the
 * navbar-switcher metadata (id / name / color / role) — the
 * `constants` blob lives on the full group row. `useGroups` has a
 * 60s staleTime so hydration is essentially free once anywhere in
 * the app has fetched it.
 */
export function useCurrentGroup(): Group | null {
  const me = useMe();
  const groups = useGroups(!!me.data);
  const currentId = me.data?.current_group_id ?? null;
  if (!currentId || !groups.data) return null;
  return groups.data.find((g) => g.id === currentId) ?? null;
}

/**
 * Effective app name for the current tenant. Empty / whitespace-
 * only values fall back to the built-in default so a group whose
 * admin cleared the field never lands on a blank navbar. Callers
 * can (and should) use this directly wherever `"Waypoint"` used to
 * be a hardcoded string.
 */
export function useAppName(): string {
  const group = useCurrentGroup();
  const raw = group?.constants?.app_name;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || DEFAULT_APP_NAME;
}

/**
 * Live-fetched constants for a specific group. Used by the
 * Constants admin form to hydrate the input on first render and to
 * observe writes made in other tabs. `useCurrentGroup` already
 * carries the same values (via `useGroups`) but this is the
 * canonical source of truth when the admin is actively editing —
 * mutations invalidate this key alongside `["groups"]` so the
 * cross-reference stays consistent.
 */
export function useGroupConstants(groupId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["groupConstants", groupId],
    queryFn: () => api<AppConstants>(`/groups/${groupId}/constants`),
    enabled: enabled && !!groupId,
    staleTime: 30_000,
  });
}
