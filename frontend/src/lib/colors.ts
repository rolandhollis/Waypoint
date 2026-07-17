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
