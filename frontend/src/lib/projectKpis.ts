import type { Project, ProjectKpiAssignment } from "./types";

/** Ordered KPI ids from a project's assignment list. */
export function projectKpiIds(
  kpis: ProjectKpiAssignment[] | undefined | null,
): string[] {
  return (kpis ?? []).map((a) => a.kpi_id);
}

/** True when the project lists this KPI (any position). */
export function projectHasKpi(
  kpis: ProjectKpiAssignment[] | undefined | null,
  kpiId: string,
): boolean {
  return (kpis ?? []).some((a) => a.kpi_id === kpiId);
}

/** Primary (first) KPI id, or null. */
export function primaryKpiId(
  kpis: ProjectKpiAssignment[] | undefined | null,
): string | null {
  return (kpis ?? [])[0]?.kpi_id ?? null;
}

export function projectKpiIdsFromProject(p: Pick<Project, "kpis">): string[] {
  return projectKpiIds(p.kpis);
}
