import type { ReactNode } from "react";
import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/**
 * ZiffSplit homepage background (`home_hero`).
 *
 * Renders as a fixed-height decorative layer. HomeView places it
 * behind the overview cards so the image does not push content down.
 *
 * - Container feature flag **off** → nothing rendered
 * - contentSource `authored` → PM HTML (typically an `<img>`) fills the layer
 * - contentSource `code` / no assignment → default mountain image
 *
 * Without VITE_AB_SITE_KEY the default mountain still renders so local
 * dev without ZiffSplit stays branded.
 */
export const HOME_HERO_CONTAINER = "home_hero";

const HERO_SHELL =
  "relative h-40 w-full overflow-hidden sm:h-48 lg:h-56";

function HeroShell({ children }: { children: ReactNode }) {
  return (
    <div className={HERO_SHELL} aria-hidden>
      {children}
      {/* Soft fade into page background under the overlapping cards */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-wp-bg" />
    </div>
  );
}

function DefaultMountainHero() {
  return (
    <HeroShell>
      <img
        src="/hero-mountain.jpg"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-[center_45%]"
      />
    </HeroShell>
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
        <HeroShell>
          <AbAuthoredHtml html={html} className="ab-authored-html ab-home-hero" />
        </HeroShell>
      );
    }
  }

  return <DefaultMountainHero />;
}
