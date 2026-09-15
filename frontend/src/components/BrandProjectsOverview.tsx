import { useMemo, type ReactNode } from "react";
import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import {
  rawTextByLabel,
  useJiffPageContent,
} from "../lib/jiffcontent";
import { useProjects, useSwimLanes } from "../lib/queries";
import type { SwimLane } from "../lib/types";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/** JiffSplit container — on/off gate + experiment slot for authored/code variants. */
export const PROJECTS_OVERVIEW_CONTAINER = "projects_overview";

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

function SlotShell({
  blockName,
  pageName,
  children,
}: {
  blockName?: string;
  pageName: string;
  children: ReactNode;
}) {
  return (
    <section
      className="card-surface p-4"
      data-block-name={blockName}
      data-block-type="brand.projects_overview"
      data-jiff-component="projects_overview"
      data-jiff-page={pageName}
      data-zs-container={PROJECTS_OVERVIEW_CONTAINER}
      data-zs-page="/"
    >
      {children}
    </section>
  );
}

/**
 * Layout block `brand.projects_overview`.
 * Copy from JC placements on `page_name` (default `homepage`); counts from Waypoint APIs.
 * JiffSplit container `projects_overview`: off → hide; on + authored assignment → PM HTML;
 * otherwise the default CMS-backed card (experiments are still evaluated for sticky/exposure).
 */
export function BrandProjectsOverview({ pageName = "homepage", blockName }: Props) {
  const ab = useAbSdk();
  void ab.previewRevision;

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

  const splitConfigured = isAbSdkConfigured();
  // Wait for Split config so we don't flash the card before an off flag applies.
  const splitPending = splitConfigured && !ab.ready;
  const splitDisabled =
    splitConfigured && !ab.error && ab.ready && !ab.isContainerEnabled(PROJECTS_OVERVIEW_CONTAINER);

  // Always leave a discoverable marker for JiffSplit Inspector, even when gated off.
  if (splitPending || splitDisabled) {
    return (
      <div
        hidden
        aria-hidden
        data-zs-container={PROJECTS_OVERVIEW_CONTAINER}
        data-zs-page="/"
        data-zs-type="html"
        data-block-name={blockName}
        data-block-type="brand.projects_overview"
      />
    );
  }

  // Evaluate + sticky/exposure — required for experiments on this container.
  const assignment =
    splitConfigured && !ab.error && ab.ready
      ? ab.getAssignmentByContainer(PROJECTS_OVERVIEW_CONTAINER)
      : null;

  // API treatments: original (code) → default card; blank authored → hide; HTML → replace.
  if (assignment?.contentSource === "authored") {
    const html = assignment.authoredContent ?? "";
    if (!html.trim()) {
      return (
        <div
          hidden
          aria-hidden
          data-zs-container={PROJECTS_OVERVIEW_CONTAINER}
          data-zs-page="/"
          data-zs-type="html"
          data-block-name={blockName}
          data-block-type="brand.projects_overview"
        />
      );
    }
    return (
      <SlotShell blockName={blockName} pageName={pageName}>
        <AbAuthoredHtml
          html={html}
          className="ab-authored-html ab-projects-overview"
        />
      </SlotShell>
    );
  }

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
    <SlotShell blockName={blockName} pageName={pageName}>
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
    </SlotShell>
  );
}
