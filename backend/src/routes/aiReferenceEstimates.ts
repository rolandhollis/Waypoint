import { Router } from "express";
import { z } from "zod";
import { parse as parseCsvSync } from "csv-parse/sync";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { AiReferenceEstimateRow } from "../types.js";

/**
 * Curated "gold-standard" reference estimates used to seed the AI
 * phase-size suggester's few-shot pool. Loaded first (highest
 * priority) then unioned with historical projects flagged
 * `dev_estimate_sourced_by_dev = TRUE` in backend/src/ai/estimator.ts.
 *
 * Group-scoped like every other tenant catalog. Reads open to any
 * group member; writes admin-only (curating the pool is a
 * governance action — a stray "S = 90 days" would poison every
 * subsequent suggestion).
 *
 * CSV import mirrors imports.ts (`preview` → user reviews per-row
 * validation → `commit`), reusing the same `csv-parse/sync` parser
 * so we don't drag in a second dependency.
 */
export const aiReferenceEstimatesRouter = Router();

/** Canonical CSV header contract. Documented in the admin UI too —
 *  keep the two copies in sync. */
export const CSV_HEADERS = [
  "title",
  "description",
  "discovery_days",
  "development_days",
  "post_dev_days",
  "notes",
  "source_label",
] as const;

const REQUIRED_HEADERS = ["title"] as const;

// ------------------------------------------------------------------
// Shared row shape used by the manual add / edit / commit endpoints.
// - title required
// - description optional (empty string when omitted at CSV time)
// - at least one of the three *_days must be non-null
// - each *_days integer must be >= 0 (mirrors the DB CHECK)
// - notes / source_label optional
// ------------------------------------------------------------------
const DAY_FIELD_KEYS = ["discovery_days", "development_days", "post_dev_days"] as const;
type DayField = (typeof DAY_FIELD_KEYS)[number];

const rowShape = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(50_000).optional().default(""),
    discovery_days: z.number().int().min(0).max(3650).nullable().optional(),
    development_days: z.number().int().min(0).max(3650).nullable().optional(),
    post_dev_days: z.number().int().min(0).max(3650).nullable().optional(),
    notes: z.string().max(2_000).nullable().optional(),
    source_label: z.string().max(500).nullable().optional(),
  })
  .refine(
    (r) =>
      r.discovery_days != null ||
      r.development_days != null ||
      r.post_dev_days != null,
    { message: "at least one of discovery_days/development_days/post_dev_days must be provided" },
  );

type ReferenceEstimateInput = z.infer<typeof rowShape>;

/** Trim + normalize the optional string fields on the way IN so
 *  callers can't smuggle whitespace-only "values" through the API. */
function normalizeInput(row: ReferenceEstimateInput): ReferenceEstimateInput {
  const description = (row.description ?? "").trim();
  const notes = row.notes != null ? row.notes.trim() : null;
  const source_label = row.source_label != null ? row.source_label.trim() : null;
  return {
    title: row.title.trim(),
    description,
    discovery_days: row.discovery_days ?? null,
    development_days: row.development_days ?? null,
    post_dev_days: row.post_dev_days ?? null,
    notes: notes || null,
    source_label: source_label || null,
  };
}

// ------------------------------------------------------------------
// GET /api/ai-reference-estimates — list all curated rows for the
// caller's tenant, ordered by position. Any group member can read;
// mutations require admin (below).
// ------------------------------------------------------------------
aiReferenceEstimatesRouter.get("/", async (req, res) => {
  const { rows } = await query<AiReferenceEstimateRow>(
    `SELECT *
       FROM ai_reference_estimates
      WHERE group_id = $1
      ORDER BY position ASC, created_at ASC`,
    [req.groupId!],
  );
  res.json(rows);
});

// ------------------------------------------------------------------
// POST /api/ai-reference-estimates — create one. Admin-only.
// New rows land at MAX(position)+1 so they show up at the bottom
// of the list; drag-reorder rewrites the whole set separately.
// ------------------------------------------------------------------
aiReferenceEstimatesRouter.post("/", requireAdmin, async (req, res) => {
  const parsed = normalizeInput(rowShape.parse(req.body));
  const groupId = req.groupId!;
  const created = await withTransaction(async (client) => {
    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM ai_reference_estimates WHERE group_id = $1`,
      [groupId],
    );
    const position = maxRows[0]?.next ?? 0;
    const { rows } = await client.query<AiReferenceEstimateRow>(
      `INSERT INTO ai_reference_estimates
         (group_id, title, description, discovery_days, development_days,
          post_dev_days, notes, source_label, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        groupId,
        parsed.title,
        parsed.description,
        parsed.discovery_days,
        parsed.development_days,
        parsed.post_dev_days,
        parsed.notes,
        parsed.source_label,
        position,
        req.user!.id,
      ],
    );
    return rows[0]!;
  });
  res.status(201).json(created);
});

// ------------------------------------------------------------------
// PATCH /api/ai-reference-estimates/:id — full-shape edit. Admin-only.
// Uses the same rowShape as create so all invariants stay identical.
// ------------------------------------------------------------------
aiReferenceEstimatesRouter.patch("/:id", requireAdmin, async (req, res) => {
  const parsed = normalizeInput(rowShape.parse(req.body));
  const groupId = req.groupId!;
  const { rows } = await query<AiReferenceEstimateRow>(
    `UPDATE ai_reference_estimates
        SET title = $1,
            description = $2,
            discovery_days = $3,
            development_days = $4,
            post_dev_days = $5,
            notes = $6,
            source_label = $7
      WHERE id = $8 AND group_id = $9
      RETURNING *`,
    [
      parsed.title,
      parsed.description,
      parsed.discovery_days,
      parsed.development_days,
      parsed.post_dev_days,
      parsed.notes,
      parsed.source_label,
      req.params.id,
      groupId,
    ],
  );
  if (!rows[0]) throw new HttpError(404, "reference estimate not found");
  res.json(rows[0]);
});

// ------------------------------------------------------------------
// DELETE /api/ai-reference-estimates/:id — admin-only. No cascade
// or side-effects; positions stay as-is (they're stable pointers,
// not gap-free indices). Reorder endpoint compacts them if needed.
// ------------------------------------------------------------------
aiReferenceEstimatesRouter.delete("/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM ai_reference_estimates WHERE id = $1 AND group_id = $2`,
    [req.params.id, req.groupId!],
  );
  if (!rowCount) throw new HttpError(404, "reference estimate not found");
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// POST /api/ai-reference-estimates/reorder — bulk drag-reorder.
// Admin-only. Body: { orderedIds: string[] }. Rewrites positions
// 0..n-1 in the caller's tenant in one transaction. IDs missing
// from the payload keep their existing relative order and are
// appended after the sorted subset — matches the projects
// reorder-lane contract so a stale client can't accidentally
// destroy items it didn't render.
// ------------------------------------------------------------------
const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

aiReferenceEstimatesRouter.post("/reorder", requireAdmin, async (req, res) => {
  const body = reorderSchema.parse(req.body);
  const groupId = req.groupId!;
  await withTransaction(async (client) => {
    const { rows: current } = await client.query<{ id: string }>(
      `SELECT id FROM ai_reference_estimates
        WHERE group_id = $1
        ORDER BY position ASC, created_at ASC
        FOR UPDATE`,
      [groupId],
    );
    const currentIds = current.map((r) => r.id);
    const currentSet = new Set(currentIds);
    const foreign = body.orderedIds.filter((id) => !currentSet.has(id));
    if (foreign.length) {
      throw new HttpError(400, `ids not in this group: ${foreign.join(", ")}`);
    }
    const seen = new Set<string>();
    const orderedSubset: string[] = [];
    for (const id of body.orderedIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      orderedSubset.push(id);
    }
    const tail = currentIds.filter((id) => !seen.has(id));
    const finalOrder = [...orderedSubset, ...tail];
    for (let i = 0; i < finalOrder.length; i++) {
      await client.query(
        `UPDATE ai_reference_estimates
            SET position = $1
          WHERE id = $2 AND position <> $1`,
        [i, finalOrder[i]],
      );
    }
  });
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// CSV import — preview / commit split.
//
// Preview parses + validates the raw CSV text, returning a per-row
// report. Nothing is persisted; the frontend renders per-row
// checkboxes so the admin can drop bad rows before committing.
//
// A STRUCTURALLY malformed CSV (unparseable, missing required
// header, wrong shape) fails fast with 400. Per-row validation
// errors keep the whole response at 200 with each row's own
// error string — the UI wants to render them side by side.
// ------------------------------------------------------------------

type PreviewRowError = {
  index: number;
  valid: boolean;
  error?: string;
  parsed?: ReferenceEstimateInput;
  raw: Record<string, string>;
};

const previewSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
});

aiReferenceEstimatesRouter.post("/import/preview", requireAdmin, async (req, res) => {
  const { csv } = previewSchema.parse(req.body);

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

  const headerRow = records[0]!.map((h) => h.trim().toLowerCase());
  const headerSet = new Set(headerRow);
  const missing = REQUIRED_HEADERS.filter((h) => !headerSet.has(h));
  if (missing.length) {
    throw new HttpError(
      400,
      `CSV is missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Expected header: ${CSV_HEADERS.join(",")}`,
    );
  }
  const unknown = headerRow.filter((h) => h && !CSV_HEADERS.includes(h as (typeof CSV_HEADERS)[number]));
  if (unknown.length) {
    throw new HttpError(
      400,
      `CSV has unknown column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Expected header: ${CSV_HEADERS.join(",")}`,
    );
  }

  const headerIndex = new Map<string, number>();
  headerRow.forEach((h, i) => {
    if (h) headerIndex.set(h, i);
  });

  const dataRows = records.slice(1);
  const rows: PreviewRowError[] = dataRows.map((cells, i) => {
    const raw: Record<string, string> = {};
    for (const header of CSV_HEADERS) {
      const idx = headerIndex.get(header);
      raw[header] = idx == null ? "" : (cells[idx] ?? "").trim();
    }
    const { valid, error, parsed } = parseCsvRow(raw);
    return { index: i, valid, error, parsed, raw };
  });

  res.json({ rows });
});

const commitSchema = z.object({
  rows: z.array(rowShape).min(1).max(1000),
});

aiReferenceEstimatesRouter.post("/import/commit", requireAdmin, async (req, res) => {
  const { rows: bodyRows } = commitSchema.parse(req.body);
  const normalized = bodyRows.map(normalizeInput);
  const groupId = req.groupId!;

  const createdCount = await withTransaction(async (client) => {
    const { rows: maxRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM ai_reference_estimates WHERE group_id = $1`,
      [groupId],
    );
    let position = maxRows[0]?.next ?? 0;
    let created = 0;
    for (const row of normalized) {
      await client.query(
        `INSERT INTO ai_reference_estimates
           (group_id, title, description, discovery_days, development_days,
            post_dev_days, notes, source_label, position, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          groupId,
          row.title,
          row.description,
          row.discovery_days,
          row.development_days,
          row.post_dev_days,
          row.notes,
          row.source_label,
          position,
          req.user!.id,
        ],
      );
      position++;
      created++;
    }
    return created;
  });

  res.json({ createdCount });
});

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Parse one CSV row (canonical keys already trimmed) into either
 * a valid ReferenceEstimateInput or an inline error string. Kept
 * separate from the zod schema because CSV-flavor inputs (blank
 * cells = "not set", strings for integers, etc.) don't map 1:1
 * onto the JSON body schema.
 */
function parseCsvRow(raw: Record<string, string>): {
  valid: boolean;
  error?: string;
  parsed?: ReferenceEstimateInput;
} {
  const title = (raw.title ?? "").trim();
  if (!title) return { valid: false, error: "title is required" };

  const description = (raw.description ?? "").trim();
  const notes = (raw.notes ?? "").trim() || null;
  const source_label = (raw.source_label ?? "").trim() || null;

  const dayValues: Partial<Record<DayField, number | null>> = {};
  for (const field of DAY_FIELD_KEYS) {
    const rawVal = (raw[field] ?? "").trim();
    if (!rawVal) {
      dayValues[field] = null;
      continue;
    }
    if (!/^-?\d+$/.test(rawVal)) {
      return { valid: false, error: `${field} "${rawVal}" is not an integer` };
    }
    const n = Number.parseInt(rawVal, 10);
    if (n < 0) return { valid: false, error: `${field} must be >= 0` };
    if (n > 3650) return { valid: false, error: `${field} is unreasonably large (>3650)` };
    dayValues[field] = n;
  }

  if (
    dayValues.discovery_days == null &&
    dayValues.development_days == null &&
    dayValues.post_dev_days == null
  ) {
    return {
      valid: false,
      error: "at least one of discovery_days/development_days/post_dev_days must be non-blank",
    };
  }

  const parsed: ReferenceEstimateInput = {
    title,
    description,
    discovery_days: dayValues.discovery_days ?? null,
    development_days: dayValues.development_days ?? null,
    post_dev_days: dayValues.post_dev_days ?? null,
    notes,
    source_label,
  };
  return { valid: true, parsed };
}
