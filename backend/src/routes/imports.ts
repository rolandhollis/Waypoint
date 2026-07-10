import { Router } from "express";
import { z } from "zod";
import { parse as parseCsvSync } from "csv-parse/sync";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import {
  recordAudit,
  replaceProjectTeams,
  validatePhaseDates,
} from "./projects.js";
import type { ProjectRow, TeamRow, UserRow } from "../types.js";

export const importsRouter = Router();

/**
 * CSV import for backlog items. Two-phase:
 *   1. POST /imports/csv/preview — parse + validate + resolve names to
 *      ids, return a per-row report.
 *   2. POST /imports/csv/commit — accept the ids-resolved rows the user
 *      chose to keep and insert each as a new project in the default
 *      lane.
 *
 * Both endpoints are admin-only. All rows land as epics (no parent);
 * subtasks aren't supported via CSV because there's no clean way to
 * reference other rows as parents in a flat spreadsheet.
 */

// Canonical column names and their case-insensitive aliases. Anything
// not in this map is silently ignored.
const COLUMN_ALIASES: Record<string, string> = {
  title: "title",
  name: "title",
  description: "description",
  desc: "description",
  notes: "description",
  owner_email: "owner_email",
  owner: "owner_email",
  email: "owner_email",
  teams: "teams",
  team: "teams",
  tags: "tags",
  tag: "tags",
  type: "type",
  start_date: "start_date",
  start: "start_date",
  discovery_start: "start_date",
  target_date: "target_date",
  discovery_end: "target_date",
  target: "target_date",
  dev_start_date: "dev_start_date",
  dev_start: "dev_start_date",
  dev_end_date: "dev_end_date",
  dev_end: "dev_end_date",
  optimization_start_date: "optimization_start_date",
  opt_start: "optimization_start_date",
  optimization_end_date: "optimization_end_date",
  opt_end: "optimization_end_date",
};

/** Fields whose value is a comma-separated list at CSV time. */
const LIST_FIELDS = new Set<string>(["teams", "tags"]);

/** Field → order for a friendly "phase dates" display in the client. */
export const CSV_DATE_FIELDS = [
  "start_date",
  "target_date",
  "dev_start_date",
  "dev_end_date",
  "optimization_start_date",
  "optimization_end_date",
] as const;

/**
 * Row shape the frontend renders in the preview list and echoes back
 * on commit. Uuids are already resolved so commit is a straight
 * insert with no lookups.
 */
export type ResolvedRow = {
  title: string;
  description: string | null;
  owner_id: string | null;
  team_ids: string[];
  tags: string[];
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
};

type PreviewRow = {
  /** 1-based line number in the CSV (excluding the header row). */
  line: number;
  /** Original text values from the CSV, keyed by canonical column. */
  raw: Record<string, string>;
  /** Fully-resolved row ready for insert, or null if unresolvable. */
  resolved: ResolvedRow | null;
  /** Human-readable errors that make this row un-importable. */
  errors: string[];
  /** Non-fatal advisories (e.g. "column ignored"). */
  warnings: string[];
};

const previewSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
});

importsRouter.post("/csv/preview", requireAdmin, async (req, res) => {
  const { csv } = previewSchema.parse(req.body);

  // Structural validation first: parseable CSV + required `title`
  // column present. Fail fast with a fatal error the client shows as
  // a red banner instead of a per-row list.
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
  const headerRow = records[0]!.map((h) => h.trim());
  const headerMap = mapHeaders(headerRow);
  if (!Object.values(headerMap).includes("title")) {
    throw new HttpError(
      400,
      `CSV is missing a "title" column. Found columns: ${headerRow.join(", ") || "(none)"}`,
    );
  }
  const dataRows = records.slice(1);
  if (dataRows.length === 0) {
    throw new HttpError(400, "CSV has a header row but no data rows");
  }

  // Load lookup tables once and index for fast per-row resolution.
  // Teams are per-tenant; users are global (a user can own projects
  // in any group they're a member of, and we don't enforce
  // per-group ownership at CSV time to keep the tool operational
  // for one-brand imports where the owner might just be an admin).
  const users = (await query<UserRow>(`SELECT * FROM users`)).rows;
  const teams = (await query<TeamRow>(
    `SELECT * FROM teams WHERE group_id = $1`,
    [req.groupId!],
  )).rows;
  const usersByEmail = new Map(users.map((u) => [u.email.trim().toLowerCase(), u]));
  const teamsByName = new Map(teams.map((t) => [t.name.trim().toLowerCase(), t]));

  // Columns present in headers that we don't recognise — surfaced as
  // a single import-level warning so PMs know their extra columns
  // weren't silently applied.
  const unknownHeaders = headerRow.filter((h) => !COLUMN_ALIASES[h.trim().toLowerCase()] && h.trim());

  const preview: PreviewRow[] = dataRows.map((cells, i) => {
    const raw: Record<string, string> = {};
    for (const idx of headerRow.keys()) {
      const canonical = headerMap[idx];
      if (!canonical) continue;
      const value = (cells[idx] ?? "").trim();
      // If the CSV has duplicate columns pointing at the same
      // canonical name, last-write-wins. Rare in practice.
      raw[canonical] = value;
    }
    return resolveRow({ line: i + 2, raw, usersByEmail, teamsByName });
  });

  res.json({
    headers: headerRow,
    known_columns: Object.values(headerMap).filter(Boolean),
    unknown_columns: unknownHeaders,
    rows: preview,
  });
});

/**
 * Commit: for each accepted row, insert one epic in a lone
 * transaction so a mid-batch failure doesn't roll back earlier
 * successes. Returns per-row status so the client can render "X of Y
 * created" and highlight failures.
 */
const commitSchema = z.object({
  rows: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(50_000).nullable().optional(),
        owner_id: z.string().uuid().nullable().optional(),
        team_ids: z.array(z.string().uuid()).max(10).optional(),
        tags: z.array(z.string().max(64)).max(20).optional(),
        start_date: z.string().nullable().optional(),
        target_date: z.string().nullable().optional(),
        dev_start_date: z.string().nullable().optional(),
        dev_end_date: z.string().nullable().optional(),
        optimization_start_date: z.string().nullable().optional(),
        optimization_end_date: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

importsRouter.post("/csv/commit", requireAdmin, async (req, res) => {
  const { rows } = commitSchema.parse(req.body);
  const groupId = req.groupId!;

  // Default lane must belong to the caller's tenant. Same lookup
  // policy as POST /projects — is_default_new → first non-terminal
  // → anything — but scoped to the group.
  const laneRow = (
    await query<{ id: string; name: string }>(
      `SELECT id, name FROM swim_lanes
        WHERE group_id = $1
        ORDER BY is_default_new DESC,
                 is_terminal ASC,
                 "order" ASC
        LIMIT 1`,
      [groupId],
    )
  ).rows[0];
  if (!laneRow) {
    throw new HttpError(400, "cannot import: no swim lanes exist yet");
  }

  const results: Array<
    | { status: "created"; project_id: string; title: string }
    | { status: "failed"; title: string; error: string }
  > = [];

  for (const row of rows) {
    try {
      // Server-side re-validation of phase-date ordering. The preview
      // catches most of these but a client could bypass the checkbox
      // guard, so we defend on commit too.
      validatePhaseDates(row);
      const created = await withTransaction(async (client) => {
        const { rows: maxRows } = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(position), -1) + 1 AS next
             FROM projects WHERE swim_lane_id = $1 AND deleted_at IS NULL`,
          [laneRow.id],
        );
        const position = maxRows[0]?.next ?? 0;
        const { rows: insRows } = await client.query<{ id: string }>(
          `INSERT INTO projects
             (group_id, title, description, swim_lane_id, position, owner_id, tags,
              type, parent_id,
              start_date, target_date, dev_start_date, dev_end_date,
              optimization_start_date, optimization_end_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'epic',NULL,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [
            groupId,
            row.title,
            row.description ?? "",
            laneRow.id,
            position,
            row.owner_id ?? req.user!.id,
            row.tags ?? [],
            row.start_date ?? null,
            row.target_date ?? null,
            row.dev_start_date ?? null,
            row.dev_end_date ?? null,
            row.optimization_start_date ?? null,
            row.optimization_end_date ?? null,
            req.user!.id,
          ],
        );
        const projectId = insRows[0]!.id;
        if (row.team_ids?.length) {
          await replaceProjectTeams(client, projectId, row.team_ids);
        }
        await client.query(
          `INSERT INTO status_history (project_id, from_swim_lane_id, to_swim_lane_id, moved_by_user_id)
           VALUES ($1, NULL, $2, $3)`,
          [projectId, laneRow.id, req.user!.id],
        );
        // Audit trail: `from = { source: "csv" }` distinguishes the
        // event from a UI-driven create in the project timeline,
        // which is useful when tracing back what came from an
        // import batch.
        await recordAudit(client, {
          projectId,
          userId: req.user!.id,
          action: "create",
          from: { source: "csv" },
        });
        return projectId;
      });
      results.push({ status: "created", project_id: created, title: row.title });
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : (err instanceof Error ? err.message : String(err));
      results.push({ status: "failed", title: row.title, error: msg });
    }
  }

  res.json({
    lane_id: laneRow.id,
    lane_name: laneRow.name,
    results,
    created_count: results.filter((r) => r.status === "created").length,
    failed_count: results.filter((r) => r.status === "failed").length,
  });
});

// -------------------- helpers --------------------

function mapHeaders(headerRow: string[]): Record<number, string | undefined> {
  const out: Record<number, string | undefined> = {};
  headerRow.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (!key) return;
    out[i] = COLUMN_ALIASES[key];
  });
  return out;
}

function resolveRow(args: {
  line: number;
  raw: Record<string, string>;
  usersByEmail: Map<string, UserRow>;
  teamsByName: Map<string, TeamRow>;
}): PreviewRow {
  const { line, raw, usersByEmail, teamsByName } = args;
  const errors: string[] = [];
  const warnings: string[] = [];

  const title = (raw.title ?? "").trim();
  if (!title) errors.push('missing required "title"');

  // owner_email → owner_id (case-insensitive email match).
  let owner_id: string | null = null;
  if (raw.owner_email) {
    const email = raw.owner_email.trim().toLowerCase();
    const match = usersByEmail.get(email);
    if (!match) errors.push(`unknown owner "${raw.owner_email}" (no user with that email)`);
    else owner_id = match.id;
  }

  // teams (comma-sep) → team_ids. Each name resolved independently so
  // one bad name doesn't hide the others.
  const team_ids: string[] = [];
  if (raw.teams) {
    for (const rawName of splitList(raw.teams)) {
      const match = teamsByName.get(rawName.trim().toLowerCase());
      if (!match) errors.push(`unknown team "${rawName}"`);
      else team_ids.push(match.id);
    }
  }

  const tags: string[] = raw.tags ? splitList(raw.tags).map((t) => t.trim()).filter(Boolean) : [];

  // type: subtasks intentionally out-of-scope for CSV import (no way
  // to name a parent row cleanly). Reject explicitly rather than
  // silently coerce so the user isn't surprised by the outcome.
  if (raw.type && raw.type.trim().toLowerCase() !== "epic") {
    errors.push(`type "${raw.type}" isn't supported via CSV — only "epic". Restructure after import.`);
  }

  const dates: Partial<Record<(typeof CSV_DATE_FIELDS)[number], string | null>> = {};
  for (const field of CSV_DATE_FIELDS) {
    const rawVal = raw[field];
    if (!rawVal) {
      dates[field] = null;
      continue;
    }
    const iso = parseDateToIso(rawVal);
    if (!iso) {
      errors.push(`invalid ${field} "${rawVal}" — use YYYY-MM-DD or MM/DD/YYYY`);
      dates[field] = null;
    } else {
      dates[field] = iso;
    }
  }

  // Phase-date ordering. Same rule POST /projects enforces; catching
  // it here so the preview flags the row without waiting for commit.
  try {
    validatePhaseDates(dates);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
  }

  const resolved: ResolvedRow | null = errors.length
    ? null
    : {
        title,
        description: raw.description?.trim() || null,
        owner_id,
        team_ids,
        tags,
        start_date: dates.start_date ?? null,
        target_date: dates.target_date ?? null,
        dev_start_date: dates.dev_start_date ?? null,
        dev_end_date: dates.dev_end_date ?? null,
        optimization_start_date: dates.optimization_start_date ?? null,
        optimization_end_date: dates.optimization_end_date ?? null,
      };

  return { line, raw, resolved, errors, warnings };
}

/** Split a CSV cell on commas, honouring simple quoted segments. */
function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

/**
 * Accept ISO (YYYY-MM-DD), slash (MM/DD/YYYY or M/D/YYYY), or dash
 * MM-DD-YYYY. Anything ambiguous (like two-digit years) is rejected
 * so we don't silently miscalendar somebody's Q3.
 */
function parseDateToIso(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  // ISO with optional timestamp — we only keep the date portion.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  // MM/DD/YYYY or MM-DD-YYYY, single-digit month/day allowed.
  const us = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (us) {
    const m = us[1]!.padStart(2, "0");
    const d = us[2]!.padStart(2, "0");
    const y = us[3]!;
    return `${y}-${m}-${d}`;
  }
  return null;
}
