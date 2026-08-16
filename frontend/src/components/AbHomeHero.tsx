import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/**
 * Embedded ZiffSplit slot for the homepage hero (under the page title).
 *
 * Container: `home_hero`
 * Delivery: embedded
 *
 * - contentSource `authored` — PM HTML replaces the default mountain
 * - contentSource `code` (or no assignment) — default mountain hero
 *
 * Default hero always renders when SDK is off / unassigned so the
 * homepage stays branded outside an experiment.
 */
export const HOME_HERO_CONTAINER = "home_hero";

function DefaultMountainHero() {
  return (
    <div className="relative h-40 w-full overflow-hidden sm:h-48 lg:h-56">
      <img
        src="/hero-mountain.jpg"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-[center_45%]"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-wp-bg/70 via-transparent to-transparent" />
    </div>
  );
}

export function AbHomeHero() {
  const ab = useAbSdk();
  void ab.previewRevision;

  const inPreview = new URLSearchParams(window.location.search).get("zs_preview") === "1";

  if (
    isAbSdkConfigured() &&
    ab.ready &&
    !ab.error &&
    !inPreview &&
    ab.isContainerEnabled(HOME_HERO_CONTAINER)
  ) {
    const assignment = ab.getAssignmentByContainer(HOME_HERO_CONTAINER);
    if (assignment?.contentSource === "authored") {
      const html = ab.getContentByContainer(HOME_HERO_CONTAINER);
      if (html) {
        return (
          <div className="w-full overflow-hidden">
            <AbAuthoredHtml html={html} className="ab-authored-html ab-home-hero" />
          </div>
        );
      }
    }
    // Code variants / control: fall through to default mountain.
    // getAssignmentByContainer above still records exposure when an
    // experiment is attached to this container.
  }

  return <DefaultMountainHero />;
}
