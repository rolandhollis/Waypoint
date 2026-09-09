import type { ReactNode } from "react";
import type { JiffLayoutBlock } from "../lib/jiffcontent";
import { AbHomeHero } from "./AbHomeHero";
import { AbHomeActivityChartSlot } from "./AbHomeActivityChart";
import { BrandProjectsOverview } from "./BrandProjectsOverview";
import { BrandUpdatesPerUser } from "./BrandUpdatesPerUser";
import { BrandActiveAssignmentsByPm } from "./BrandActiveAssignmentsByPm";
import { HomeStatusLoadChart } from "./HomeStatusLoadChart";

type BrandBlockRenderer = (block: JiffLayoutBlock) => ReactNode;

/**
 * Waypoint modules mountable from a published JiffContent layout.
 * Block type slugs must match Admin → Content types / layout blocks (`brand.*`).
 */
const BRAND_BLOCKS: Record<string, BrandBlockRenderer> = {
  "brand.home_hero": () => <AbHomeHero />,
  "brand.projects_overview": (block) => {
    const pageName =
      typeof block.props.page_name === "string" && block.props.page_name.trim()
        ? block.props.page_name.trim()
        : "homepage";
    return <BrandProjectsOverview pageName={pageName} blockName={block.name} />;
  },
  "brand.updates_per_user": (block) => {
    const pageName =
      typeof block.props.page_name === "string" && block.props.page_name.trim()
        ? block.props.page_name.trim()
        : "homepage";
    return <BrandUpdatesPerUser pageName={pageName} blockName={block.name} />;
  },
  "brand.active_assignments_by_pm": (block) => {
    const pageName =
      typeof block.props.page_name === "string" && block.props.page_name.trim()
        ? block.props.page_name.trim()
        : "homepage";
    return <BrandActiveAssignmentsByPm pageName={pageName} blockName={block.name} />;
  },
  "brand.home_activity_chart": (block) => {
    const dayTitle =
      typeof block.props.day_title === "string" ? block.props.day_title : undefined;
    const userTitle =
      typeof block.props.user_title === "string" ? block.props.user_title : undefined;
    return <AbHomeActivityChartSlot dayTitle={dayTitle} userTitle={userTitle} />;
  },
  "brand.home_assignments": (block) => {
    const title =
      typeof block.props.title === "string" ? block.props.title : "Active Assignments by PM";
    const subtitle =
      typeof block.props.subtitle === "string" ? block.props.subtitle : undefined;
    return <HomeStatusLoadChart title={title} subtitle={subtitle} />;
  },
};

/** Edge-to-edge chrome (no content max-width / horizontal padding). */
const FULL_BLEED_TYPES = new Set(["brand.home_hero"]);

export function isFullBleedBrandBlock(type: string): boolean {
  return FULL_BLEED_TYPES.has(type);
}

export function renderBrandBlock(block: JiffLayoutBlock): ReactNode {
  const render = BRAND_BLOCKS[block.type];
  if (!render) {
    return (
      <section
        key={block.id}
        data-jiff-block={block.type}
        data-jiff-name={block.name}
        className="rounded-lg border border-dashed border-wp-stone bg-wp-paper/50 px-3 py-2 text-sm text-wp-slate"
      >
        Unregistered brand block: <code>{block.type}</code>
      </section>
    );
  }
  if (isFullBleedBrandBlock(block.type)) {
    return (
      <div key={block.id} className="w-full" data-jiff-block={block.type} data-jiff-name={block.name}>
        {render(block)}
      </div>
    );
  }
  return (
    <section key={block.id} data-jiff-block={block.type} data-jiff-name={block.name}>
      {render(block)}
    </section>
  );
}
