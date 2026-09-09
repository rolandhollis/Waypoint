import { rawTextByLabel, useJiffPageContent } from "../lib/jiffcontent";
import { HomeStatusLoadChart } from "./HomeStatusLoadChart";

type Props = {
  pageName?: string;
  blockName?: string;
};

/**
 * Layout block `brand.active_assignments_by_pm`.
 * Copy from JC placements on `page_name` (default `homepage`); counts from Waypoint APIs.
 */
export function BrandActiveAssignmentsByPm({ pageName = "homepage", blockName }: Props) {
  const cms = useJiffPageContent(pageName);
  const items = cms.data ?? [];

  const title =
    rawTextByLabel(items, "active_assignments_title") ??
    rawTextByLabel(items, "home_assignments_title") ??
    "Active Assignments by PM";
  const description =
    rawTextByLabel(items, "active_assignments_description") ??
    rawTextByLabel(items, "home_assignments_subtitle") ??
    undefined;
  const loadingText =
    rawTextByLabel(items, "active_assignments_loading_text") ?? "Loading…";
  const errorText =
    rawTextByLabel(items, "active_assignments_error_text") ??
    "Couldn’t load active assignments.";
  const emptyText =
    rawTextByLabel(items, "active_assignments_empty_text") ??
    "No owned items currently in these swim lanes.";

  return (
    <div
      data-block-name={blockName}
      data-block-type="brand.active_assignments_by_pm"
      data-jiff-component="active_assignments_by_pm"
      data-jiff-page={pageName}
    >
      <HomeStatusLoadChart
        title={title}
        subtitle={description}
        loadingText={loadingText}
        errorText={errorText}
        emptyText={emptyText}
      />
    </div>
  );
}
