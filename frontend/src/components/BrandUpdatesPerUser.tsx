import { rawTextByLabel, useJiffPageContent } from "../lib/jiffcontent";
import { ActivityByUserChart } from "./AbHomeActivityChart";

type Props = {
  pageName?: string;
  blockName?: string;
};

/**
 * Layout block `brand.updates_per_user`.
 * Copy from JC placements on `page_name` (default `homepage`); chart data from Waypoint APIs.
 */
export function BrandUpdatesPerUser({ pageName = "homepage", blockName }: Props) {
  const cms = useJiffPageContent(pageName);
  const items = cms.data ?? [];

  const title =
    rawTextByLabel(items, "updates_per_user_title") ??
    rawTextByLabel(items, "home_activity_user_title") ??
    "Updates per user";
  const loadingText =
    rawTextByLabel(items, "updates_per_user_loading_text") ?? "Loading…";
  const errorText =
    rawTextByLabel(items, "updates_per_user_error_text") ??
    "Couldn’t load activity. Try refreshing.";
  const emptyText =
    rawTextByLabel(items, "updates_per_user_empty_text") ?? "No activity in range.";

  return (
    <div
      data-block-name={blockName}
      data-block-type="brand.updates_per_user"
      data-jiff-component="updates_per_user"
      data-jiff-page={pageName}
    >
      <ActivityByUserChart
        title={title}
        loadingText={loadingText}
        errorText={errorText}
        emptyText={emptyText}
      />
    </div>
  );
}
