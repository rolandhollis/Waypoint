import { useMemo, type ReactNode } from "react";
import { AbHomeActivityChartSlot } from "../components/AbHomeActivityChart";
import { AbHomeHero } from "../components/AbHomeHero";
import { BrandProjectsOverview } from "../components/BrandProjectsOverview";
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

function HomeShell({ children, busy }: { children?: ReactNode; busy?: boolean }) {
  return (
    <div className="relative h-full overflow-auto" aria-busy={busy || undefined}>
      {children}
    </div>
  );
}

/**
 * Workspace homepage — prefers a published JiffContent page/layout at
 * `VITE_JIFFCONTENT_HOME_PATH` (default `/`). Falls back to the built-in
 * overview cards only after resolve settles with no published layout.
 */
export function HomeView() {
  const cmsConfigured = isJiffContentConfigured();
  const resolved = useJiffResolvedPage(jiffHomePagePath());
  const cmsPageDoc = publishedLayoutDocument(resolved.data);

  // Placement-based copy still powers the built-in fallback homepage.
  const cms = useJiffPageContent("homepage");
  const cmsItems = cms.data ?? [];

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

  // CMS configured and resolve still in flight — hold an empty shell so
  // we don't flash the built-in homepage before a published layout
  // arrives. On error (e.g. local JiffContent down), fall through to
  // the built-in overview instead of leaving a blank page.
  if (cmsConfigured && resolved.isPending) {
    return <HomeShell busy />;
  }

  // CMS off, resolve errored, or succeeded with no published layout → built-in.

  const projectsSection = (
    <div className="lg:col-span-4" key="projects">
      <BrandProjectsOverview pageName="homepage" />
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
