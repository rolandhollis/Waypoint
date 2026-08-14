import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/**
 * Renders authored content for a single ZiffSplit experiment.
 * Mount one instance per experiment/container you want live on the page.
 * Pausing the experiment in admin hides that instance.
 *
 * Authored content is treated as raw HTML (styles + scripts included).
 */
export function AbDemoBanner({
  experimentKey,
  placement = "page",
}: {
  experimentKey: string;
  /** `shell` = sticky top bar; `page` = inline card on the page. */
  placement?: "shell" | "page";
}) {
  const ab = useAbSdk();
  // Re-read assignments when admin preview overrides land.
  void ab.previewRevision;

  if (!isAbSdkConfigured()) return null;

  if (!ab.ready) {
    if (placement === "shell") {
      return (
        <div className="sticky top-0 z-[60] border-b border-violet-300 bg-violet-100 px-4 py-2 text-sm text-violet-950">
          ZiffSplit: loading config from localhost:4100…
        </div>
      );
    }
    return null;
  }

  if (ab.error) {
    if (placement === "shell") {
      return (
        <div className="sticky top-0 z-[60] border-b border-amber-400 bg-amber-100 px-4 py-2 text-sm text-amber-950">
          ZiffSplit error: {ab.error}. Is ziffsplit-api running on :4100?
        </div>
      );
    }
    return null;
  }

  const inPreview = new URLSearchParams(window.location.search).get("zs_preview") === "1";

  // Admin live-preview uses AbPreviewBanner for the forced experiment.
  if (inPreview) return null;

  const assignment = ab.getAssignment(experimentKey);
  const copy = ab.getContent(experimentKey);
  if (!assignment || !copy) return null;

  const className =
    placement === "shell"
      ? "sticky top-0 z-[60] border-b-2 border-violet-500 bg-violet-100 px-4 py-2.5 text-sm text-violet-950 shadow-sm"
      : "mb-3 rounded-lg border-2 border-violet-500 bg-violet-100 px-4 py-2.5 text-sm text-violet-950 shadow-sm";

  return (
    <div className={className}>
      <AbAuthoredHtml html={copy} className="ab-authored-html" />
    </div>
  );
}
