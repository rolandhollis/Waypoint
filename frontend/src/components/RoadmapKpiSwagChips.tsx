import type { Kpi, ProjectKpiAssignment } from "../lib/types";
import { cn } from "../lib/cn";

/**
 * Compact KPI + impact-SWAG chips for roadmap listings. Used under
 * project titles when "Show KPIs" is enabled in the Roadmap filter
 * cluster.
 */
export function RoadmapKpiSwagChips({
  assignments,
  kpis,
  className,
  /** Compact bars use light text on colored fills. */
  onDark,
}: {
  assignments: ProjectKpiAssignment[] | undefined | null;
  kpis: Kpi[];
  className?: string;
  onDark?: boolean;
}) {
  const byId = new Map(kpis.map((k) => [k.id, k]));
  const chips = (assignments ?? [])
    .map((a) => {
      const kpi = byId.get(a.kpi_id);
      if (!kpi) return null;
      return { kpi, swag: a.impact_swag };
    })
    .filter((x): x is { kpi: Kpi; swag: string | null } => !!x);

  if (chips.length === 0) return null;

  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-0.5", className)}>
      {chips.map(({ kpi, swag }) => (
        <span
          key={kpi.id}
          className={cn(
            // Reset Compact bar title halo (text-shadow / stroke) so
            // solid chips don't inherit a drop-shadow look.
            "inline-flex max-w-full items-center gap-0.5 truncate rounded px-1 py-px text-[10px] font-medium leading-tight text-wp-slate [text-shadow:none] [-webkit-text-stroke:0]",
            onDark ? "bg-white" : "bg-wp-stone",
          )}
          title={swag ? `${kpi.name} · SWAG ${swag}` : kpi.name}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: kpi.color }}
            aria-hidden
          />
          <span className="truncate">{kpi.name}</span>
          {swag ? (
            <span className="shrink-0 font-semibold uppercase tracking-wide text-wp-slate/80">
              {swag}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}
