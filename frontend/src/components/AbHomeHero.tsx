import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/**
 * Embedded ZiffSplit slot for the homepage hero (under the page title).
 *
 * Container: `home_hero`
 * Delivery: embedded
 *
 * - Container feature flag **off** → hero is hidden
 * - contentSource `authored` → PM HTML replaces the mountain
 * - contentSource `code` / no assignment → default mountain hero
 *
 * Without VITE_AB_SITE_KEY the default mountain still renders so local
 * dev without ZiffSplit stays branded.
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

  if (!isAbSdkConfigured()) {
    return <DefaultMountainHero />;
  }

  // Wait for config so we don't flash the hero before the flag is known.
  if (!ab.ready) return null;

  if (ab.error) {
    return <DefaultMountainHero />;
  }

  const inPreview = new URLSearchParams(window.location.search).get("zs_preview") === "1";
  if (inPreview) return null;

  // Site container feature flag — key must be exactly `home_hero`.
  if (!ab.isContainerEnabled(HOME_HERO_CONTAINER)) {
    return null;
  }

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

  return <DefaultMountainHero />;
}
