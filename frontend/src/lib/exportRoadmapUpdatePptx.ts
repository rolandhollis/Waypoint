import PptxGenJS from "pptxgenjs";
import type { DeckItemLine, RoadmapUpdateDeck, TeamDeckSection } from "./roadmapUpdateDeck";

/** Widescreen matching the RMN template (10" × 5.62"). */
const SLIDE_W = 10;
const SLIDE_H = 5.62;

/**
 * Colors sampled from the RMN Roadmap Update PPTX template.
 * Status cards use a colored header band over a lavender body.
 */
const C = {
  purple: "221176",
  monthBlue: "97B6F8",
  design: "12C9BA",
  development: "B15FDB",
  discovery: "3FA9E0",
  backlog: "E06666",
  cardBody: "F5F5FA",
  bodyText: "5B5876",
  ink: "1A1A2E",
  white: "FFFFFF",
  muted: "8B87A3",
};

// Bundled brand assets extracted from the RMN template.
import logoUrl from "../assets/roadmap-deck/ziff-davis-shopping-logo.png";
import swooshUrl from "../assets/roadmap-deck/title-swoosh.png";

async function asDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load deck asset: ${url}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function itemLines(items: DeckItemLine[], max = 8): string {
  if (!items.length) return "—";
  return items
    .slice(0, max)
    .map((i) => i.title)
    .join("\n");
}

function addTitleSlide(
  pptx: PptxGenJS,
  deck: RoadmapUpdateDeck,
  assets: { logo: string; swoosh: string },
) {
  const slide = pptx.addSlide();
  slide.background = { color: C.purple };

  // Decorative swoosh / photo frame on the right (template layout).
  slide.addImage({
    data: assets.swoosh,
    x: 6.4,
    y: 2.0,
    w: 4.2,
    h: 2.9,
  });

  slide.addText(deck.workspaceName || "RetailMeNot", {
    x: 0.85,
    y: 1.35,
    w: 7.5,
    h: 0.55,
    fontSize: 22,
    fontFace: "Arial",
    color: C.white,
  });
  slide.addText("Roadmap Update", {
    x: 0.85,
    y: 1.9,
    w: 7.5,
    h: 0.85,
    fontSize: 40,
    fontFace: "Arial",
    color: C.white,
    bold: true,
  });
  slide.addText(deck.titleDateLabel, {
    x: 0.85,
    y: 2.8,
    w: 6,
    h: 0.4,
    fontSize: 16,
    fontFace: "Arial",
    color: C.monthBlue,
  });

  // Month pill + Ziff Davis Shopping logo (bottom-left cluster).
  slide.addImage({
    data: assets.logo,
    x: 0.85,
    y: 4.55,
    w: 0.42,
    h: 0.42,
  });
  slide.addText(deck.monthLabel, {
    x: 1.4,
    y: 4.6,
    w: 3,
    h: 0.35,
    fontSize: 12,
    fontFace: "Arial",
    color: C.monthBlue,
    bold: true,
  });
}

type CardSpec = {
  title: string;
  color: string;
  items: DeckItemLine[];
  x: number;
  y: number;
};

function addStatusCard(pptx: PptxGenJS, slide: ReturnType<PptxGenJS["addSlide"]>, card: CardSpec) {
  const w = 4.35;
  const h = 1.75;
  const radius = 0.08;

  // Body
  slide.addShape(pptx.ShapeType.roundRect, {
    x: card.x,
    y: card.y,
    w,
    h,
    fill: { color: C.cardBody },
    line: { color: C.cardBody },
    shadow: { type: "outer", color: "000000", blur: 6, offset: 2, opacity: 0.08 },
    rectRadius: radius,
  });

  // Colored header band
  slide.addShape(pptx.ShapeType.rect, {
    x: card.x,
    y: card.y,
    w,
    h: 0.42,
    fill: { color: card.color },
    line: { color: card.color },
  });
  // Cover top corners of body so header looks flush with rounded card
  slide.addShape(pptx.ShapeType.roundRect, {
    x: card.x,
    y: card.y,
    w,
    h: 0.42,
    fill: { color: card.color },
    line: { color: card.color },
    rectRadius: radius,
  });

  slide.addText(card.title, {
    x: card.x + 0.18,
    y: card.y + 0.06,
    w: w - 0.36,
    h: 0.32,
    fontSize: 11,
    fontFace: "Arial",
    color: C.white,
    bold: true,
  });

  const body = itemLines(card.items);
  slide.addText(body, {
    x: card.x + 0.18,
    y: card.y + 0.52,
    w: w - 0.36,
    h: h - 0.62,
    fontSize: 11,
    fontFace: "Arial",
    color: C.bodyText,
    valign: "top",
  });
}

function addStatusSlide(pptx: PptxGenJS, section: TeamDeckSection) {
  const slide = pptx.addSlide();
  slide.background = { color: C.white };

  slide.addText(section.team.name, {
    x: 0.35,
    y: 0.18,
    w: 9.3,
    h: 0.5,
    fontSize: 28,
    fontFace: "Arial",
    color: C.ink,
    bold: true,
  });

  // Delivered strip sits under the title (template order).
  const deliveredBits = section.delivered.length
    ? section.delivered.map((d) => (d.detail ? `${d.title} — ${d.detail}` : d.title)).join("   ·   ")
    : "—";
  slide.addText(
    [
      { text: "Delivered in last 30 days:  ", options: { bold: true, color: C.purple } },
      { text: deliveredBits, options: { bold: false, color: C.bodyText } },
    ],
    {
      x: 0.35,
      y: 0.75,
      w: 9.3,
      h: 0.55,
      fontSize: 12,
      fontFace: "Arial",
      valign: "top",
    },
  );

  // 2×2 card grid — colors/order match the template:
  // DESIGN (teal) | DEVELOPMENT (purple)
  // DISCOVERY (blue) | NEW BACKLOG (coral)
  const cards: CardSpec[] = [
    { title: "DESIGN", color: C.design, items: section.design, x: 0.35, y: 1.5 },
    { title: "DEVELOPMENT", color: C.development, items: section.development, x: 5.15, y: 1.5 },
    { title: "DISCOVERY", color: C.discovery, items: section.discovery, x: 0.35, y: 3.5 },
    { title: "NEW BACKLOG ITEMS", color: C.backlog, items: section.newBacklog, x: 5.15, y: 3.5 },
  ];
  for (const card of cards) addStatusCard(pptx, slide, card);
}

/**
 * Read PNG width/height from a data URL's IHDR chunk. Used so we can
 * size the slide image frame to the capture's real aspect ratio —
 * pptxgenjs `sizing: "contain"` letterboxes via negative srcRect and
 * clamps to stretch, which vertically warps short Gantt snapshots.
 */
function pngPixelSize(dataUrl: string): { w: number; h: number } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !/^data:image\/png;base64,/i.test(dataUrl.slice(0, comma + 1))) {
    return null;
  }
  try {
    const bin = atob(dataUrl.slice(comma + 1, comma + 1 + 96));
    if (bin.length < 24) return null;
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    // 8-byte signature + 4 length + 4 "IHDR" + 4 width + 4 height
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const w = view.getUint32(16);
    const h = view.getUint32(20);
    if (!w || !h) return null;
    return { w, h };
  } catch {
    return null;
  }
}

/** Fit `src` into `box` preserving aspect (CSS object-fit: contain). */
function fitContain(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): { w: number; h: number } {
  const scale = Math.min(boxW / srcW, boxH / srcH);
  return { w: srcW * scale, h: srcH * scale };
}

function addRoadmapSlide(pptx: PptxGenJS, section: TeamDeckSection) {
  const slide = pptx.addSlide();
  slide.background = { color: C.white };

  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: 0.08,
    fill: { color: C.purple },
    line: { color: C.purple },
  });

  slide.addText(
    [
      { text: section.team.name, options: { bold: true, color: C.ink } },
      { text: "  Roadmap", options: { bold: false, color: C.muted } },
    ],
    {
      x: 0.35,
      y: 0.18,
      w: 9.3,
      h: 0.4,
      fontSize: 20,
      fontFace: "Arial",
    },
  );

  const boxX = 0.25;
  const boxY = 0.65;
  const boxW = 9.5;
  const boxH = 4.7;

  if (section.roadmapSnapshotDataUrl) {
    const px = pngPixelSize(section.roadmapSnapshotDataUrl);
    // Default to full-box only if IHDR can't be read (shouldn't happen
    // for html-to-image PNGs). Prefer exact aspect-fit so 1–2 row
    // captures stay a thin strip instead of stretching into mush.
    const fitted = px
      ? fitContain(px.w, px.h, boxW, boxH)
      : { w: boxW, h: boxH };
    slide.addImage({
      data: section.roadmapSnapshotDataUrl,
      x: boxX,
      y: boxY,
      w: fitted.w,
      h: fitted.h,
    });
    return;
  }

  // Fallback if capture failed or the team has no scheduled rows.
  if (!section.roadmapItems.length) {
    slide.addText("No scheduled roadmap items for this product area in the next 6 months.", {
      x: 0.4,
      y: 1.5,
      w: 9.2,
      h: 0.4,
      fontSize: 13,
      fontFace: "Arial",
      color: C.muted,
      italic: true,
    });
    return;
  }

  const headerFill = { color: C.purple };
  const rows = [
    [
      { text: "Item", options: { bold: true, color: C.white, fill: headerFill } },
      { text: "Start", options: { bold: true, color: C.white, fill: headerFill } },
      { text: "End", options: { bold: true, color: C.white, fill: headerFill } },
    ],
    ...section.roadmapItems.slice(0, 12).map((item, idx) => {
      const zebra = idx % 2 === 0 ? C.cardBody : C.white;
      return [
        { text: item.title, options: { color: C.ink, fill: { color: zebra }, align: "left" as const } },
        { text: item.start ?? "—", options: { color: C.bodyText, fill: { color: zebra }, align: "center" as const } },
        { text: item.end ?? "—", options: { color: C.bodyText, fill: { color: zebra }, align: "center" as const } },
      ];
    }),
  ];

  slide.addTable(rows, {
    x: 0.4,
    y: 0.9,
    w: 9.2,
    colW: [5.8, 1.7, 1.7],
    border: { type: "solid", pt: 0.5, color: "E4E0F0" },
    fontFace: "Arial",
    fontSize: 11,
    color: C.ink,
    valign: "middle",
  });
}

/**
 * Build and download a Roadmap Update PPTX matching the RMN template look:
 * purple title slide, 2×2 colored status cards, branded roadmap slides.
 */
export async function exportRoadmapUpdatePptx(deck: RoadmapUpdateDeck): Promise<void> {
  const [logo, swoosh] = await Promise.all([asDataUrl(logoUrl), asDataUrl(swooshUrl)]);

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "ROADMAP_UPDATE", width: SLIDE_W, height: SLIDE_H });
  pptx.layout = "ROADMAP_UPDATE";
  pptx.author = "Waypoint";
  pptx.title = `${deck.workspaceName} Roadmap Update — ${deck.titleDateLabel}`;

  addTitleSlide(pptx, deck, { logo, swoosh });
  for (const section of deck.sections) {
    addStatusSlide(pptx, section);
    addRoadmapSlide(pptx, section);
  }

  const stamp = deck.generatedAt.toISOString().slice(0, 10);
  const safeName = (deck.workspaceName || "Roadmap").replace(/[^\w\- ]+/g, "").trim() || "Roadmap";
  await pptx.writeFile({ fileName: `${safeName} Roadmap Update - ${stamp}.pptx` });
}
