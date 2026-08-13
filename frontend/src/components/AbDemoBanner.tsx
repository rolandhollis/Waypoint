import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";

/**
 * Demo surface for ZiffSplit on Waypoint.
 * Controlled by flag `waypoint_demo_banner` and experiment `waypoint_banner_copy`.
 */
export function AbDemoBanner() {
  const ab = useAbSdk();

  if (!isAbSdkConfigured()) return null;

  if (!ab.ready) {
    return (
      <div className="sticky top-0 z-[60] border-b border-violet-300 bg-violet-100 px-4 py-2 text-sm text-violet-950">
        ZiffSplit: loading config from localhost:4100…
      </div>
    );
  }

  if (ab.error) {
    return (
      <div className="sticky top-0 z-[60] border-b border-amber-400 bg-amber-100 px-4 py-2 text-sm text-amber-950">
        ZiffSplit error: {ab.error}. Is ziffsplit-api running on :4100?
      </div>
    );
  }

  if (!ab.isOn("waypoint_demo_banner")) {
    return (
      <div className="sticky top-0 z-[60] border-b border-stone-300 bg-stone-100 px-4 py-2 text-sm text-stone-700">
        ZiffSplit connected (config v{ab.configVersion ?? "?"}), but flag{" "}
        <code>waypoint_demo_banner</code> is off.
      </div>
    );
  }

  const copy = ab.getContent("waypoint_banner_copy") ?? "ZiffSplit connected.";
  const assignment = ab.getAssignment("waypoint_banner_copy");

  return (
    <div className="sticky top-0 z-[60] border-b-2 border-violet-500 bg-violet-100 px-4 py-2.5 text-sm font-medium text-violet-950 shadow-sm">
      <strong>ZiffSplit:</strong> {copy}
      {assignment ? (
        <span className="ml-2 font-normal text-violet-800/80">
          (variant: {assignment.variantKey})
        </span>
      ) : null}
    </div>
  );
}
