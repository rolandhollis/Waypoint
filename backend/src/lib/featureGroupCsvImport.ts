import { parse as parseCsvSync } from "csv-parse/sync";
import { HttpError } from "../middleware/error.js";
import { normalizePriorityTier, type PriorityTier } from "../lib/priorityTiers.js";

export type ParsedFeatureCsvRow = {
  line: number;
  priority_tier: PriorityTier;
  name: string;
  description: string;
  tier_coerced: boolean;
};

const COLUMN_ALIASES: Record<string, "priority_tier" | "name" | "description"> = {
  "priority tier": "priority_tier",
  priority_tier: "priority_tier",
  priority: "priority_tier",
  tier: "priority_tier",
  name: "name",
  title: "name",
  feature: "name",
  description: "description",
  desc: "description",
};

function isHeaderRow(cells: string[]): boolean {
  return cells.some((cell) => {
    const key = cell.trim().toLowerCase();
    return key in COLUMN_ALIASES;
  });
}

function mapHeaderRow(cells: string[]): Map<number, "priority_tier" | "name" | "description"> {
  const map = new Map<number, "priority_tier" | "name" | "description">();
  for (let i = 0; i < cells.length; i++) {
    const canonical = COLUMN_ALIASES[cells[i]?.trim().toLowerCase() ?? ""];
    if (canonical) map.set(i, canonical);
  }
  return map;
}

/**
 * Parse a feature-group CSV. Expects columns priority tier, name, and
 * description (header row or positional). Row order in the file is
 * preserved as overall rank on import.
 */
export function parseFeatureGroupCsv(csv: string): ParsedFeatureCsvRow[] {
  let records: string[][];
  try {
    records = parseCsvSync(csv, {
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `Could not parse CSV: ${msg}`);
  }

  if (records.length === 0) {
    throw new HttpError(400, "CSV is empty");
  }

  const first = records[0]!.map((c) => c.trim());
  const hasHeader = isHeaderRow(first);
  const dataRows = hasHeader ? records.slice(1) : records;

  if (dataRows.length === 0) {
    throw new HttpError(400, "CSV has no data rows");
  }

  const headerMap = hasHeader ? mapHeaderRow(first) : null;
  if (hasHeader && !Array.from(headerMap!.values()).includes("name")) {
    throw new HttpError(400, 'CSV is missing a "name" column');
  }

  const out: ParsedFeatureCsvRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i]!.map((c) => c.trim());
    if (cells.every((c) => !c)) continue;

    let tierRaw: string;
    let name: string;
    let description: string;

    if (headerMap) {
      const raw: Partial<Record<"priority_tier" | "name" | "description", string>> = {};
      for (const [idx, key] of headerMap.entries()) {
        raw[key] = cells[idx] ?? "";
      }
      tierRaw = raw.priority_tier ?? "";
      name = (raw.name ?? "").trim();
      description = (raw.description ?? "").trim();
    } else {
      tierRaw = cells[0] ?? "";
      name = (cells[1] ?? "").trim();
      description = (cells[2] ?? "").trim();
    }

    if (!name) continue;

    const { tier, coerced } = normalizePriorityTier(tierRaw);

    out.push({
      line: hasHeader ? i + 2 : i + 1,
      priority_tier: tier,
      name,
      description,
      tier_coerced: coerced,
    });
  }

  if (out.length === 0) {
    throw new HttpError(400, "CSV has no rows with a feature name");
  }

  return out;
}
