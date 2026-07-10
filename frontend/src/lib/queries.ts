import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type {
  Group,
  Kpi,
  PendingStatusResponse,
  Project,
  ProjectComment,
  ProjectTimelineEntry,
  Role,
  StatusReportResponse,
  SwimLane,
  Team,
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

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<Project[]>("/projects"),
    refetchInterval: POLL_MS,
  });
}

export function useProjectHistory(id: string) {
  return useQuery({
    queryKey: ["projectHistory", id],
    queryFn: () => api<ProjectTimelineEntry[]>(`/projects/${id}/history`),
    enabled: !!id,
  });
}

export function useProjectStatusUpdates(id: string) {
  return useQuery({
    queryKey: ["projectStatusUpdates", id],
    queryFn: () => api<WeeklyStatusUpdate[]>(`/projects/${id}/status-updates`),
    enabled: !!id,
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
