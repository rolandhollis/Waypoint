import { useMemo } from "react";
import {
  rawTextByLabel,
  useJiffPageContent,
} from "../lib/jiffcontent";
import { useProjects, useSwimLanes } from "../lib/queries";
import type { SwimLane } from "../lib/types";

type Props = {
  pageName?: string;
  blockName?: string;
};

function laneNameKey(lane: Pick<SwimLane, "name">): string {
  return lane.name.trim().toLowerCase();
}

function isNonActiveLane(lane: SwimLane): boolean {
  const name = laneNameKey(lane);
  if (lane.is_archive) return true;
  if (lane.is_terminal) return true;
  if (lane.is_default_new) return true;
  if (name === "backlog") return true;
  if (name === "parking lot") return true;
  return false;
}

/**
 * Layout block `brand.projects_overview`.
 * Copy from JC placements on `page_name` (default `homepage`); counts from Waypoint APIs.
 */
export function BrandProjectsOverview({ pageName = "homepage", blockName }: Props) {
  const projects = useProjects();
  const lanes = useSwimLanes();
  const cms = useJiffPageContent(pageName);
  const items = cms.data ?? [];

  const projectCounts = useMemo(() => {
    const list = projects.data ?? [];
    const laneById = new Map((lanes.data ?? []).map((l) => [l.id, l]));
    let inProgress = 0;
    for (const p of list) {
      if (!p.swim_lane_id) continue;
      const lane = laneById.get(p.swim_lane_id);
      if (!lane) continue;
      if (!isNonActiveLane(lane)) inProgress += 1;
    }
    return { total: list.length, inProgress };
  }, [projects.data, lanes.data]);

  const loading = projects.isLoading || lanes.isLoading;
  const errored = projects.isError || lanes.isError;

  const title =
    rawTextByLabel(items, "projects_title") ??
    rawTextByLabel(items, "home_projects_title") ??
    "Projects";
  const description =
    rawTextByLabel(items, "projects_description") ??
    rawTextByLabel(items, "home_projects_subtitle") ??
    "In progress excludes backlog, complete, parking lot, and archive.";
  const totalLabel =
    rawTextByLabel(items, "projects_total_label") ??
    rawTextByLabel(items, "home_projects_total_label") ??
    "Total";
  const inProgressLabel =
    rawTextByLabel(items, "projects_in_progress_label") ??
    rawTextByLabel(items, "home_projects_in_progress_label") ??
    "In progress";
  const loadingText = rawTextByLabel(items, "projects_loading_text") ?? "Loading…";
  const errorText =
    rawTextByLabel(items, "projects_error_text") ?? "Couldn’t load project counts.";

  return (
    <section
      className="card-surface p-4"
      data-block-name={blockName}
      data-block-type="brand.projects_overview"
      data-jiff-component="projects_overview"
      data-jiff-page={pageName}
    >
      <h2 className="text-base font-semibold text-wp-ink" data-jiff-label="projects_title">
        {title}
      </h2>
      <p className="mt-1 text-xs text-wp-slate" data-jiff-label="projects_description">
        {description}
      </p>
      {loading ? (
        <p className="mt-6 text-sm text-wp-slate" data-jiff-label="projects_loading_text">
          {loadingText}
        </p>
      ) : errored ? (
        <p className="mt-6 text-sm text-wp-red" data-jiff-label="projects_error_text">
          {errorText}
        </p>
      ) : (
        <dl className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-wp-stone bg-wp-paper/60 px-3 py-3">
            <dt
              className="text-[11px] font-medium uppercase tracking-wide text-wp-slate"
              data-jiff-label="projects_total_label"
            >
              {totalLabel}
            </dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums text-wp-ink">
              {projectCounts.total}
            </dd>
          </div>
          <div className="rounded-lg border border-wp-stone bg-wp-paper/60 px-3 py-3">
            <dt
              className="text-[11px] font-medium uppercase tracking-wide text-wp-slate"
              data-jiff-label="projects_in_progress_label"
            >
              {inProgressLabel}
            </dt>
            <dd className="mt-1 text-3xl font-semibold tabular-nums text-wp-ink">
              {projectCounts.inProgress}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
