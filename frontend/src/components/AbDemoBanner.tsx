import { getAbApiBaseUrl, isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/**
 * Renders authored content for the active experiment on a registered container.
 * Developers mount by container key; PMs attach experiments to that container
 * in admin. If several experiments are active on the same container, the SDK
 * uses the first that assigns (prefer one active experiment per slot).
 *
 * Authored content is treated as raw HTML (styles + scripts included).
 */
export function AbDemoBanner({
  containerKey,
  placement = "page",
}: {
  containerKey: string;
  /** `shell` = sticky top bar; `page` = inline card on the page. */
  placement?: "shell" | "page";
}) {
  const ab = useAbSdk();
  // Re-read assignments when admin preview overrides land.
  void ab.previewRevision;

  if (!isAbSdkConfigured()) return null;

  const apiBase = getAbApiBaseUrl();

  if (!ab.ready) {
    if (placement === "shell") {
      return (
        <div className="sticky top-0 z-[60] border-b border-violet-300 bg-violet-100 px-4 py-2 text-sm text-violet-950">
          ZiffSplit: loading config from {apiBase}…
        </div>
      );
    }
    return null;
  }

  if (ab.error) {
    if (placement === "shell") {
      const hint = ab.error.includes("404")
        ? "Unknown site key — copy the production API key from ZiffSplit Admin → Settings and redeploy with VITE_AB_SITE_KEY."
        : `Check that ${apiBase} is reachable.`;
      return (
        <div className="sticky top-0 z-[60] border-b border-amber-400 bg-amber-100 px-4 py-2 text-sm text-amber-950">
          ZiffSplit error: {ab.error}. {hint}
        </div>
      );
    }
    return null;
  }

  const inPreview = new URLSearchParams(window.location.search).get("zs_preview") === "1";

  // Admin live-preview uses AbPreviewBanner for the forced experiment.
  if (inPreview) return null;

  const assignment = ab.getAssignmentByContainer(containerKey);
  const copy = ab.getContentByContainer(containerKey);
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
