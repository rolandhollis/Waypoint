import { useMemo, type ReactNode } from "react";
import {
  useProjects,
  useSwimLanes,
} from "../lib/queries";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { AbHomeActivityChartSlot } from "../components/AbHomeActivityChart";
import { AbHomeHero } from "../components/AbHomeHero";
import { HomeStatusLoadChart } from "../components/HomeStatusLoadChart";
import { JiffLayoutRenderer } from "../components/JiffLayoutRenderer";
import {
  boolFromText,
  imageByLabel,
  isJiffContentConfigured,
  jiffHomePagePath,
  publishedLayoutDocument,
  rawTextByLabel,
  useJiffPageContent,
  useJiffResolvedPage,
} from "../lib/jiffcontent";
import type { SwimLane } from "../lib/types";

function laneNameKey(lane: Pick<SwimLane, "name">): string {
  return lane.name.trim().toLowerCase();
}

/** Lanes that are not active delivery work (backlog, complete, parking lot, archive). */
function isNonActiveLane(lane: SwimLane): boolean {
  const name = laneNameKey(lane);
  if (lane.is_archive) return true;
  if (lane.is_terminal) return true;
  if (lane.is_default_new) return true;
  if (name === "backlog") return true;
  if (name === "parking lot") return true;
  return false;
}

function HomeShell({ children, busy }: { children?: ReactNode; busy?: boolean }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader tabKey="home" />
      <div className="relative flex-1 overflow-auto" aria-busy={busy || undefined}>
        {children}
      </div>
    </div>
  );
}

/**
 * Workspace homepage — prefers a published JiffContent page/layout at
 * `VITE_JIFFCONTENT_HOME_PATH` (default `/`). Falls back to the built-in
 * overview cards only after resolve settles with no published layout.
 */
export function HomeView() {
  const projects = useProjects();
  const lanes = useSwimLanes();
  const cmsConfigured = isJiffContentConfigured();
  const resolved = useJiffResolvedPage(jiffHomePagePath());
  const cmsPageDoc = publishedLayoutDocument(resolved.data);

  // Placement-based copy still powers the built-in fallback homepage.
  const cms = useJiffPageContent("homepage");
  const cmsItems = cms.data ?? [];

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

  const countsLoading = projects.isLoading || lanes.isLoading;
  const projectsTitle = rawTextByLabel(cmsItems, "home_projects_title") ?? "Projects";
  const projectsSubtitle =
    rawTextByLabel(cmsItems, "home_projects_subtitle") ??
    "In progress excludes backlog, complete, parking lot, and archive.";
  const totalLabel = rawTextByLabel(cmsItems, "home_projects_total_label") ?? "Total";
  const inProgressLabel = rawTextByLabel(cmsItems, "home_projects_in_progress_label") ?? "In progress";

  const activityDayTitle = rawTextByLabel(cmsItems, "home_activity_day_title") ?? "Updates per day";
  const activityUserTitle = rawTextByLabel(cmsItems, "home_activity_user_title") ?? "Updates per user";
  const assignmentsTitle =
    rawTextByLabel(cmsItems, "home_assignments_title") ?? "Active Assignments by PM";
  const assignmentsSubtitle = rawTextByLabel(cmsItems, "home_assignments_subtitle") ?? undefined;

  const showProjects = boolFromText(rawTextByLabel(cmsItems, "home_show_projects"), true);
  const showActivity = boolFromText(rawTextByLabel(cmsItems, "home_show_activity"), true);
  const showAssignments = boolFromText(rawTextByLabel(cmsItems, "home_show_assignments"), true);
  const sectionOrderRaw = rawTextByLabel(cmsItems, "home_section_order");
  const sectionOrder = useMemo(() => {
    const allowed = new Set(["projects", "activity", "assignments"]);
    const parsed = (sectionOrderRaw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is "projects" | "activity" | "assignments" => allowed.has(s));
    const deduped: Array<"projects" | "activity" | "assignments"> = [];
    for (const key of parsed) {
      if (!deduped.includes(key)) deduped.push(key);
    }
    for (const fallback of ["projects", "activity", "assignments"] as const) {
      if (!deduped.includes(fallback)) deduped.push(fallback);
    }
    return deduped;
  }, [sectionOrderRaw]);

  const cmsHeroImage = imageByLabel(cmsItems, "home_hero_image");
  const cmsHeroTitle = rawTextByLabel(cmsItems, "home_hero_title");
  const cmsHeroSubtitle = rawTextByLabel(cmsItems, "home_hero_subtitle");

  if (cmsPageDoc) {
    return (
      <HomeShell>
        <JiffLayoutRenderer document={cmsPageDoc} />
      </HomeShell>
    );
  }

  // CMS configured but resolve has not succeeded yet (pending or error).
  // Never paint the built-in homepage here — a later success would flicker.
  if (cmsConfigured && !resolved.isSuccess) {
    return (
      <HomeShell busy>
        {resolved.isError ? (
          <p className="p-5 text-sm text-wp-slate">Couldn’t load homepage content.</p>
        ) : null}
      </HomeShell>
    );
  }

  // CMS off, or resolve succeeded with no published layout → built-in.

  const projectsSection = (
    <div className="lg:col-span-4" key="projects">
      <section className="card-surface p-4">
        <h2 className="text-base font-semibold text-wp-ink">{projectsTitle}</h2>
        <p className="mt-1 text-xs text-wp-slate">{projectsSubtitle}</p>
        {countsLoading ? (
          <p className="mt-6 text-sm text-wp-slate">Loading…</p>
        ) : projects.isError || lanes.isError ? (
          <p className="mt-6 text-sm text-wp-red">Couldn’t load project counts.</p>
        ) : (
          <dl className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-wp-stone bg-wp-paper/60 px-3 py-3">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-wp-slate">
                {totalLabel}
              </dt>
              <dd className="mt-1 text-3xl font-semibold tabular-nums text-wp-ink">
                {projectCounts.total}
              </dd>
            </div>
            <div className="rounded-lg border border-wp-stone bg-wp-paper/60 px-3 py-3">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-wp-slate">
                {inProgressLabel}
              </dt>
              <dd className="mt-1 text-3xl font-semibold tabular-nums text-wp-ink">
                {projectCounts.inProgress}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  );

  const activitySection = (
    <div className="lg:col-span-8" key="activity">
      <AbHomeActivityChartSlot dayTitle={activityDayTitle} userTitle={activityUserTitle} />
    </div>
  );

  const assignmentsSection = (
    <div className="lg:col-span-12" key="assignments">
      <HomeStatusLoadChart title={assignmentsTitle} subtitle={assignmentsSubtitle} />
    </div>
  );

  return (
    <HomeShell>
      <div className="relative z-10">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0">
          {cmsConfigured && cmsHeroImage ? (
            <div className="relative h-40 w-full overflow-hidden sm:h-48 lg:h-56" aria-hidden>
              <img
                src={cmsHeroImage.url}
                alt={cmsHeroImage.alt}
                className="absolute inset-0 h-full w-full object-cover object-[center_45%]"
              />
              {(cmsHeroTitle || cmsHeroSubtitle) ? (
                <div className="absolute inset-0 flex items-end">
                  <div className="px-5 pb-4 text-white drop-shadow">
                    {cmsHeroTitle ? <p className="text-xl font-semibold">{cmsHeroTitle}</p> : null}
                    {cmsHeroSubtitle ? <p className="mt-0.5 text-sm">{cmsHeroSubtitle}</p> : null}
                  </div>
                </div>
              ) : null}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-wp-bg" />
            </div>
          ) : (
            <AbHomeHero />
          )}
        </div>
        <div className="relative z-10 p-5">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-12">
            {sectionOrder.map((section) => {
              if (section === "projects") return showProjects ? projectsSection : null;
              if (section === "activity") return showActivity ? activitySection : null;
              if (section === "assignments") return showAssignments ? assignmentsSection : null;
              return null;
            })}
          </div>
        </div>
      </div>
    </HomeShell>
  );
}
