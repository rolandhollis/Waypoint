import type { Project } from "./types";
import type { FilterState } from "./viewState";

export function applyFilters(projects: Project[], f: FilterState): Project[] {
  const q = f.search.trim().toLowerCase();
  return projects.filter((p) => {
    if (p.deleted_at) return false;
    if (f.ownerIds.length && (!p.owner_id || !f.ownerIds.includes(p.owner_id))) return false;
    if (f.teamIds.length && !p.teams.some((t) => f.teamIds.includes(t))) return false;
    if (f.swimLaneIds.length && (!p.swim_lane_id || !f.swimLaneIds.includes(p.swim_lane_id))) return false;
    if (f.tags.length && !p.tags.some((t) => f.tags.includes(t))) return false;
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
    (f.dateFrom ? 1 : 0) + (f.dateTo ? 1 : 0)
  );
}
