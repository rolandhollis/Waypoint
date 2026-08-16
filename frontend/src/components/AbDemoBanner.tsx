import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/**
 * Renders authored content for the active experiment on a registered container.
 * Developers mount by container key; PMs attach experiments to that container
 * in admin. If several experiments are active on the same container, the SDK
 * uses the first that assigns (prefer one active experiment per slot).
 *
 * Authored content is treated as raw HTML (styles + scripts included).
 * Stays invisible until content is ready to avoid loading / empty flashes.
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

  // Never paint loading chrome — wait for content to avoid layout flicker.
  if (!ab.ready) return null;

  if (ab.error) {
    if (import.meta.env.DEV && placement === "shell") {
      return (
        <div className="sticky top-0 z-30 border-b border-amber-400 bg-amber-100 px-4 py-2 text-sm text-amber-950">
          ZiffSplit error: {ab.error}
        </div>
      );
    }
    return null;
  }

  if (!ab.isContainerEnabled(containerKey)) return null;

  const inPreview = new URLSearchParams(window.location.search).get("zs_preview") === "1";

  // Admin live-preview uses AbPreviewBanner for the forced experiment.
  if (inPreview) return null;

  const assignment = ab.getAssignmentByContainer(containerKey);
  const copy = ab.getContentByContainer(containerKey);
  if (!assignment || !copy) return null;

  const className =
    placement === "shell"
      ? "sticky top-0 z-30 border-b-2 border-violet-500 bg-violet-100 px-4 py-2.5 text-sm text-violet-950 shadow-sm"
      : "mb-3 rounded-lg border-2 border-violet-500 bg-violet-100 px-4 py-2.5 text-sm text-violet-950 shadow-sm";

  return (
    <div className={className}>
      <AbAuthoredHtml html={copy} className="ab-authored-html" />
    </div>
  );
}
