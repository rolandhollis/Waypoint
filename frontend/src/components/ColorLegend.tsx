import { useMemo } from "react";
import type { ProductArea, Project, SwimLane, User } from "../lib/types";
import type { ColorBy } from "../lib/viewState";

export function ColorLegend(props: {
  colorBy: ColorBy;
  lanes: SwimLane[];
  areas: ProductArea[];
  users: User[];
  scopedProjects: Project[];
}) {
  const { colorBy, lanes, areas, users, scopedProjects } = props;
  const entries = useMemo(() => {
    if (colorBy === "swim_lane") {
      const activeIds = new Set(scopedProjects.map((p) => p.swim_lane_id));
      return lanes.filter((l) => activeIds.has(l.id)).map((l) => ({ id: l.id, label: l.name, color: l.color ?? "#94a3b8" }));
    }
    if (colorBy === "product_area") {
      const activeIds = new Set(scopedProjects.map((p) => p.product_area_id));
      return areas.filter((a) => activeIds.has(a.id)).map((a) => ({ id: a.id, label: a.name, color: a.color }));
    }
    const activeIds = new Set(scopedProjects.map((p) => p.owner_id));
    return users.filter((u) => activeIds.has(u.id)).map((u) => ({ id: u.id, label: u.name, color: u.color }));
  }, [colorBy, lanes, areas, users, scopedProjects]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-wp-slate">
      <span className="font-medium">Color</span>
      {entries.map((e) => (
        <span key={e.id} className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
      {entries.length === 0 ? <span>(no data)</span> : null}
    </div>
  );
}
