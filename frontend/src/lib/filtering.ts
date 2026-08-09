import type { Project } from "./types";
import type { FilterState } from "./viewState";

/** Sentinel values stored in `ownerIds` / `teamIds` — not real entity ids. */
export const FILTER_UNASSIGNED_OWNER = "__filter_unassigned_owner__";
export const FILTER_UNASSIGNED_TEAM = "__filter_unassigned_team__";

export function matchesOwnerFilter(ownerId: string | null | undefined, ownerIds: string[]): boolean {
  if (!ownerIds.length) return true;
  const wantsUnassigned = ownerIds.includes(FILTER_UNASSIGNED_OWNER);
  const ids = ownerIds.filter((id) => id !== FILTER_UNASSIGNED_OWNER);
  if (!ownerId && wantsUnassigned) return true;
  if (ownerId && ids.includes(ownerId)) return true;
  return false;
}

export function matchesTeamFilter(teamIdsOnProject: string[], teamIds: string[]): boolean {
  if (!teamIds.length) return true;
  const wantsUnassigned = teamIds.includes(FILTER_UNASSIGNED_TEAM);
  const ids = teamIds.filter((id) => id !== FILTER_UNASSIGNED_TEAM);
  if (teamIdsOnProject.length === 0 && wantsUnassigned) return true;
  if (teamIdsOnProject.some((t) => ids.includes(t))) return true;
  return false;
}

export function filterOwnerChipLabel(id: string, users: { id: string; name: string }[]): string {
  if (id === FILTER_UNASSIGNED_OWNER) return "Unassigned";
  return users.find((x) => x.id === id)?.name ?? id;
}

export function filterTeamChipLabel(id: string, teams: { id: string; name: string }[]): string {
  if (id === FILTER_UNASSIGNED_TEAM) return "Unassigned";
  return teams.find((x) => x.id === id)?.name ?? id;
}

export function applyFilters(projects: Project[], f: FilterState): Project[] {
  const q = f.search.trim().toLowerCase();
  return projects.filter((p) => {
    if (p.deleted_at) return false;
    if (!matchesOwnerFilter(p.owner_id, f.ownerIds)) return false;
    if (!matchesTeamFilter(p.teams, f.teamIds)) return false;
    if (f.swimLaneIds.length && (!p.swim_lane_id || !f.swimLaneIds.includes(p.swim_lane_id))) return false;
    if (f.tags.length && !p.tags.some((t) => f.tags.includes(t))) return false;
    if (f.keyStrategicOnly && !p.is_key_strategic) return false;
    if (f.dateFrom || f.dateTo) {
      const start = p.start_date ? new Date(`${p.start_date}T00:00:00`).getTime() : null;
      const end = p.target_date ? new Date(`${p.target_date}T00:00:00`).getTime() : null;
      const from = f.dateFrom ? new Date(`${f.dateFrom}T00:00:00`).getTime() : null;
      const to = f.dateTo ? new Date(`${f.dateTo}T23:59:59`).getTime() : null;
      if (start === null && end === null) return false;
      if (from && end !== null && end < from) return false;
      if (to && start !== null && start > to) return false;
    }
    if (q && !p.title.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function countActiveFilters(f: FilterState): number {
  return (
    f.ownerIds.length + f.teamIds.length + f.swimLaneIds.length +
    f.tags.length +
    (f.keyStrategicOnly ? 1 : 0) +
    (f.dateFrom ? 1 : 0) + (f.dateTo ? 1 : 0)
  );
}
