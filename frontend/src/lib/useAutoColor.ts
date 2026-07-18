import { useMemo, useState } from "react";
import { pickUnusedColor } from "./colors";

/**
 * "Auto-pick an unused color from `palette`, but let the user override"
 * hook — the shape every admin `Add …` form needs.
 *
 * Returns [color, setColor, reset]:
 *   * `color` — the effective color to bind into the picker + POST
 *     body. Starts as the first palette entry that isn't already in
 *     `used`; falls back to the least-repeated entry when every slot
 *     is taken.
 *   * `setColor(c)` — user override. Once called, the returned
 *     `color` sticks at whatever the user picked, even if `used`
 *     later changes (their choice wins).
 *   * `reset()` — drop the override so `color` snaps back to a fresh
 *     autopick. Call after a successful create so the NEXT add
 *     starts from the (now different) unused set instead of reusing
 *     the color the operator just picked.
 *
 * Notes on the shape of this API:
 *   * We deliberately return the AUTO-picked color from `color`
 *     rather than mixing "auto vs override" state into a discriminated
 *     union — the picker and the POST body both want a single string,
 *     and downstream code stays trivial ("just use `color`").
 *   * `useMemo` on the autopick makes the recompute cheap and stable
 *     across rerenders that don't change the used set.
 */
export function useAutoColor(
  palette: readonly string[],
  used: readonly (string | null | undefined)[],
): [string, (c: string) => void, () => void] {
  const suggested = useMemo(() => pickUnusedColor(palette, used), [palette, used]);
  const [override, setOverride] = useState<string | null>(null);
  const color = override ?? suggested;
  return [color, setOverride, () => setOverride(null)];
}
