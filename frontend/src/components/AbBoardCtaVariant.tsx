import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";

/**
 * Developer-coded (codeVariantKey) experiment slot for the Board page.
 *
 * PMs create an experiment on container `board_cta` with contentSource=code
 * and codeVariantKey values that match the cases below. The SDK only returns
 * the assignment + key — React here owns the UI.
 */
const CONTAINER_KEY = "board_cta";

export function AbBoardCtaVariant() {
  const ab = useAbSdk();
  void ab.previewRevision;

  if (!isAbSdkConfigured() || !ab.ready || ab.error) return null;

  if (!ab.isContainerEnabled(CONTAINER_KEY)) return null;

  const inPreview = new URLSearchParams(window.location.search).get("zs_preview") === "1";
  // Live preview forces authored HTML via AbPreviewBanner; hide this slot then.
  if (inPreview) return null;

  const assignment = ab.getAssignmentByContainer(CONTAINER_KEY);
  if (!assignment || assignment.contentSource !== "code") return null;

  const key = assignment.codeVariantKey ?? "cta_neutral";

  if (key === "cta_emphasized") {
    return (
      <div className="border-b border-emerald-600 bg-emerald-50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-emerald-950">
              Code variant: <code className="font-mono">{key}</code>
            </p>
            <p className="text-sm text-emerald-900">
              Emphasized CTA — shipped in Waypoint, selected by ZiffSplit.
            </p>
          </div>
          <a
            href="http://localhost:5174"
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            Open ZiffSplit admin
          </a>
        </div>
      </div>
    );
  }

  if (key === "cta_compact") {
    return (
      <div className="border-b border-sky-500 bg-sky-50 px-4 py-1.5 text-xs text-sky-950">
        <span className="font-semibold">Code variant <code>{key}</code></span>
        {" — "}
        <a href="http://localhost:5174" className="font-semibold underline underline-offset-2">
          Admin
        </a>
      </div>
    );
  }

  // cta_neutral (control) and unknown keys fall through here
  return (
    <div className="border-b border-stone-300 bg-stone-50 px-4 py-2 text-sm text-stone-800">
      Code variant: <code className="font-mono">{key}</code>
      {" — neutral control UI (developer-coded). "}
      <button
        type="button"
        className="ml-2 text-stone-600 underline underline-offset-2 hover:text-stone-900"
        onClick={() => {
          window.__ziffsplit?.clearAssignments({ rebucket: true });
          window.location.reload();
        }}
      >
        Rebucket
      </button>
    </div>
  );
}

declare global {
  interface Window {
    __ziffsplit?: {
      clearAssignments: (opts?: { rebucket?: boolean }) => void;
    };
  }
}
