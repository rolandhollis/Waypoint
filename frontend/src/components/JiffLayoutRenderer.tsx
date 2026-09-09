import type { CSSProperties, ReactNode } from "react";
import type {
  JiffLayoutBlock,
  JiffLayoutDocument,
  JiffLayoutRow,
  JiffLayoutRowBackground,
} from "../lib/jiffcontent";
import { isFullBleedBrandBlock, renderBrandBlock } from "./jiffBrandBlocks";

const DEFAULT_CONTAINED_MAX = "72rem";

function cssSize(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return `${value}px`;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return `${raw}px`;
  return raw;
}

function imageAlign(value: unknown): "left" | "center" | "right" {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "center" || key === "right") return key;
  return "left";
}

function rowBackgroundStyle(bg: JiffLayoutRowBackground | undefined): CSSProperties {
  if (!bg) return {};
  const style: CSSProperties = {};
  if (bg.color) style.backgroundColor = bg.color;
  if (bg.image_url) {
    style.backgroundImage = `url(${JSON.stringify(bg.image_url)})`;
    style.backgroundSize = "cover";
    style.backgroundPosition = "center";
    style.backgroundRepeat = "no-repeat";
  }
  return style;
}

/** Explicit row width, else auto-full for known full-bleed brand blocks. */
function rowIsFullWidth(row: JiffLayoutRow): boolean {
  if (row.width === "full") return true;
  if (row.width === "contained") return false;
  return row.columns.some((col) => col.blocks.some((b) => isFullBleedBrandBlock(b.type)));
}

function rowShellStyle(row: JiffLayoutRow, fullWidth: boolean): CSSProperties {
  const style = rowBackgroundStyle(row.background);
  if (!fullWidth) {
    style.maxWidth = row.max_width?.trim() || DEFAULT_CONTAINED_MAX;
    style.marginLeft = "auto";
    style.marginRight = "auto";
    style.width = "100%";
  }
  return style;
}

function renderBlock(block: JiffLayoutBlock): ReactNode {
  const props = block.props ?? {};

  if (block.render === "html" || block.type === "jc.rich_html") {
    const html = String(props.html ?? "");
    if (!html.trim()) return null;
    return (
      <section key={block.id} data-jiff-block={block.type} data-jiff-name={block.name}>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </section>
    );
  }

  if (block.type === "jc.raw_text") {
    const text = String(props.text ?? "");
    if (!text) return null;
    return (
      <section key={block.id} data-jiff-block={block.type} data-jiff-name={block.name}>
        <p className="whitespace-pre-wrap text-wp-ink">{text}</p>
      </section>
    );
  }

  if (block.type === "jc.image") {
    const url = String(props.url ?? "").trim();
    if (!url) return null;
    const alt = String(props.alt_text ?? block.name);
    const width = cssSize(props.width);
    const height = cssSize(props.height);
    const align = imageAlign(props.align);
    const style: CSSProperties = {
      width: width ?? "auto",
      height: height ?? "auto",
      maxWidth: "100%",
    };
    const alignClass =
      align === "center" ? "justify-center" : align === "right" ? "justify-end" : "justify-start";
    return (
      <section key={block.id} data-jiff-block={block.type} data-jiff-name={block.name}>
        <div className={`flex ${alignClass}`}>
          <img src={url} alt={alt} style={style} />
        </div>
      </section>
    );
  }

  if (block.type.startsWith("brand.")) {
    return renderBrandBlock(block);
  }

  return (
    <section
      key={block.id}
      data-jiff-block={block.type}
      data-jiff-name={block.name}
      className="rounded-lg border border-dashed border-wp-stone bg-wp-paper/50 px-3 py-2 text-sm text-wp-slate"
    >
      Unknown block: <code>{block.type}</code>
    </section>
  );
}

function renderRows(rows: JiffLayoutRow[], gridColumns: number, nested: boolean): ReactNode {
  return rows.map((row) => {
    const fullWidth = rowIsFullWidth(row);
    // Nested `width: "full"` is full width of the parent column, not the viewport.
    const shellClass = fullWidth
      ? "w-full"
      : nested
        ? "box-border w-full py-2"
        : "box-border w-full px-5 py-4";
    return (
      <div key={row.id} className={shellClass} style={rowShellStyle(row, fullWidth)}>
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
          }}
        >
          {row.columns.map((col) => (
            <div
              key={col.id}
              className="min-w-0"
              style={{ gridColumn: `span ${Math.min(col.span, gridColumns)}` }}
            >
              <div className={fullWidth ? "flex flex-col" : "flex flex-col gap-3"}>
                {col.blocks.map((block) => renderBlock(block))}
                {col.rows?.length ? (
                  <div className="flex flex-col gap-2">{renderRows(col.rows, gridColumns, true)}</div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  });
}

/** Renders a published JiffContent layout document (grid → rows → columns → blocks / nested rows). */
export function JiffLayoutRenderer({ document }: { document: JiffLayoutDocument }) {
  const gridColumns = document.grid?.columns || 12;

  return (
    <div className="flex flex-col" data-jiff-layout>
      {renderRows(document.rows, gridColumns, false)}
    </div>
  );
}
