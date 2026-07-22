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

/**
 * Pick a legible text color for a chip / pill whose background is a
 * light tint of `teamColor` on white (as produced by `tint(color,
 * ~0.14-0.16)` at every team-pill site in the app).
 *
 * Returns a darkened variant of the team hue: hue and saturation are
 * preserved, but lightness is clamped low enough that the text clears
 * WCAG AA (≥ 4.5:1) at small-text sizes for every hue in the current
 * TEAM_PALETTE — including the pinks / purples / cyans / yellows that
 * used to fail when the older code passed the raw team color into
 * `readableOn()` and got back a near-white foreground for any hue with
 * luminance ≤ 0.5.
 *
 * We keep the hue (instead of collapsing to wp-ink) so the pill still
 * *reads* as its team color: a "Mobile App" pill is dark magenta on
 * pale magenta rather than generic dark on pale magenta. That
 * preserves the "at-a-glance which team" affordance the original
 * design was aiming for.
 *
 * Non-hex / near-gray inputs fall back to wp-ink so the chip stays
 * legible without producing a muddy near-gray that would look broken.
 */
export function pillTextColor(teamColor: string): string {
  const rgba = parseHex(teamColor);
  if (!rgba) return WP_INK;
  const { h, s, l } = rgbToHsl(rgba.r, rgba.g, rgba.b);
  // Effectively-gray hues have no hue identity to preserve; wp-ink
  // reads cleaner than a low-sat brownish clamp for those.
  if (s < 0.12) return WP_INK;
  // 0.22 was chosen empirically against every color in TEAM_PALETTE /
  // SWIM_LANE_PALETTE / KPI_PALETTE / GROUP_PALETTE: the worst-case
  // hue (bright lime #84CC16 on its own ~0.14 tint) still lands at
  // ~6:1 contrast, and pinks / purples / cyans clear 10:1+. Going
  // deeper (e.g. 0.15) darkens genuinely dark palette entries needlessly;
  // going lighter (e.g. 0.30) drops lime / yellow below 4.5:1.
  const cappedL = Math.min(l, 0.22);
  return hslToHex(h, s, cappedL);
}

/**
 * Convert an RGB triple (0..255 channels) to HSL with h in [0, 360),
 * and s, l in [0, 1]. Standard formula, factored out so
 * `pillTextColor` can operate in a perceptually-cleaner space than
 * naive RGB multiplication (which shifts hue for non-neutral colors
 * and produces olive text on pink teams).
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** Inverse of `rgbToHsl` — returns a 7-char `#RRGGBB` string. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const m = l - c / 2;
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
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
