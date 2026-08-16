import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { AbAuthoredHtml } from "./AbAuthoredHtml";

/**
 * Renders whatever experiment admin is previewing (`zs_exp`), so live
 * preview works even when that experiment isn't normally mounted on
 * this route. Authored content is raw HTML (styles + scripts included).
 */
export function AbPreviewBanner() {
  const ab = useAbSdk();
  void ab.previewRevision;

  if (!isAbSdkConfigured() || typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  if (params.get("zs_preview") !== "1") return null;

  const experimentKey = params.get("zs_exp");
  if (!experimentKey) return null;

  if (!ab.ready) {
    return (
      <div className="sticky top-0 z-30 border-b border-violet-300 bg-violet-100 px-4 py-2 text-sm text-violet-950">
        ZiffSplit preview: loading…
      </div>
    );
  }

  if (ab.error) {
    return (
      <div className="sticky top-0 z-30 border-b border-amber-400 bg-amber-100 px-4 py-2 text-sm text-amber-950">
        ZiffSplit preview error: {ab.error}
      </div>
    );
  }

  const assignment = ab.getAssignment(experimentKey);
  const copy = ab.getContent(experimentKey);
  if (!assignment || copy === null || copy === "") {
    return (
      <div className="sticky top-0 z-30 border-b border-amber-400 bg-amber-50 px-4 py-2 text-sm text-amber-950">
        ZiffSplit preview: no content for <code>{experimentKey}</code>
        {assignment ? ` · ${assignment.variantKey}` : ""}. Save the variant or
        check the experiment key.
      </div>
    );
  }

  return (
    <div className="sticky top-0 z-30 border-b-2 border-fuchsia-500 bg-fuchsia-100 px-4 py-2.5 text-sm text-fuchsia-950 shadow-sm">
      <AbAuthoredHtml html={copy} className="ab-authored-html" />
    </div>
  );
}
