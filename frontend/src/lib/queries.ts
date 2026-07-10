import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type {
  Kpi,
  PendingStatusResponse,
  Project,
  ProjectComment,
  ProjectTimelineEntry,
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

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => api<User[]>("/users"),
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
