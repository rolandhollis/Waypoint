/**
 * Color utilities for entity-tinted UI (team, KPI, lane, owner chips).
 *
 * The picker in Admin lets people choose *any* hex for a team, so we
 * can't hard-code text/border pairs at design time. Chips that render
 * a colored entity name (Board cards, KPI report rows, ...) need to
 * pick their text color at render time or the low-luminance combos
 * — bright yellow team on white being the worst — disappear against
 * the light card surface.
 */

/** wp-ink from the tailwind theme. Kept in sync with tailwind.config.ts. */
const WP_INK = "#101828";

/** Add an alpha suffix to a #RRGGBB color, producing a #RRGGBBAA hex.
 *  `alpha` is the fractional opacity (0..1); values outside that range
 *  are clamped. Non-hex inputs are returned unchanged so callers can
 *  pass CSS keywords like "transparent" without a special case. */
export function tint(color: string, alpha: number): string {
  if (!isHexColor(color)) return color;
  const clamped = Math.max(0, Math.min(1, alpha));
  const suffix = Math.round(clamped * 255).toString(16).padStart(2, "0");
  // Drop any existing alpha so tint() is idempotent when a caller re-tints.
  const base = color.slice(0, 7);
  return `${base}${suffix}`;
}

/** Pick a readable text color (#ffffff or wp-ink) for the given
 *  background. Accepts #RGB, #RRGGBB, or #RRGGBBAA; transparent inputs
 *  are blended onto white before luminance is measured, since every
 *  chip site in the app sits on a white card / row. */
export function readableOn(bgColor: string): string {
  const rgba = parseHex(bgColor);
  if (!rgba) return WP_INK;
  const { r, g, b, a } = rgba;
  const rEff = r * a + 255 * (1 - a);
  const gEff = g * a + 255 * (1 - a);
  const bEff = b * a + 255 * (1 - a);
  // WCAG relative luminance threshold of ~0.5 puts the switch point
  // near mid-gray — above it near-black wins, below it white does.
  return relativeLuminance(rEff, gEff, bEff) > 0.5 ? WP_INK : "#ffffff";
}

function isHexColor(v: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
}

function parseHex(v: string): { r: number; g: number; b: number; a: number } | null {
  if (!isHexColor(v)) return null;
  let hex = v.slice(1);
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function relativeLuminance(r: number, g: number, b: number): number {
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

// -----------------------------------------------------------------
// Palettes + "pick an unused color" helper
// -----------------------------------------------------------------

/**
 * Curated palettes for the admin "Add …" forms. Each palette is
 * ordered — earlier entries are picked first when nothing conflicts,
 * so the palette order also acts as the default preference. Chosen
 * to be visually distinct from each other (max distance in HSL space
 * within each palette) so autopicks don't produce two teams the eye
 * groups together.
 *
 * If you extend one of these, keep the entries case-normalized (upper
 * for lanes/teams/kpis/groups, since that's what the existing seed
 * data uses) — case-insensitive comparison happens in
 * `pickUnusedColor`.
 */
export const SWIM_LANE_PALETTE = [
  "#94A3B8", "#38BDF8", "#22C55E", "#F59E0B", "#EF4444",
  "#A855F7", "#EC4899", "#14B8A6", "#8B5CF6", "#F97316",
] as const;

export const TEAM_PALETTE = [
  "#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#0EA5E9", "#84CC16",
] as const;

export const KPI_PALETTE = [
  "#0EA5E9", "#F97316", "#10B981", "#A855F7", "#F59E0B",
  "#EC4899", "#22C55E", "#F43F5E", "#6366F1", "#14B8A6",
] as const;

export const GROUP_PALETTE = [
  "#6366F1", "#DC2626", "#059669", "#D97706", "#7C3AED",
  "#DB2777", "#0891B2", "#EA580C", "#65A30D", "#0F766E",
] as const;

/**
 * "Owner avatar" palette. Kept intentionally short and warm-biased
 * so avatar bubbles read as a small, memorable set — same 8 colors
 * that shipped with the app originally.
 */
export const USER_PALETTE = [
  "#DC2626", "#EA580C", "#D97706", "#65A30D",
  "#0EA5E9", "#6366F1", "#9333EA", "#64748B",
] as const;

/**
 * Return the first palette entry that isn't already assigned to any
 * of `used`. Comparison is case-insensitive on the #RRGGBB form so
 * "#DC2626" and "#dc2626" collide. If every palette entry is taken
 * we fall back to the palette entry with the FEWEST occurrences in
 * `used` — biases the auto-pick toward the least-repeated color,
 * which still helps a bit when a workspace has more items than
 * palette slots.
 */
export function pickUnusedColor(
  palette: readonly string[],
  used: readonly (string | null | undefined)[],
): string {
  const norm = (c: string) => c.toLowerCase().slice(0, 7);
  const counts = new Map<string, number>();
  for (const c of used) {
    if (!c) continue;
    const key = norm(c);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const first = palette[0] ?? "#94A3B8";
  let bestColor = first;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const p of palette) {
    const key = norm(p);
    const n = counts.get(key) ?? 0;
    if (n === 0) return p;
    if (n < bestCount) {
      bestCount = n;
      bestColor = p;
    }
  }
  return bestColor;
}
