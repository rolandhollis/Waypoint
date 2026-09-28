/**
 * Import Product Design Tickets from Doug's prototype CSV export.
 *
 * Expected columns (PRD §5.1 / export):
 *   id, person, order, title, sub, status, jira, links, due
 *
 * `person` is a display name (Doug / Isa / …) or Unassigned / Completed.
 * `status` is the workflow pill (not|on|risk|review|indev|done) or labels.
 * `links` may be JSON or "Label|url; Label|url".
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/import_design_tickets.ts [path-to.csv] [--group RetailMeNot] [--replace]
 *
 * --replace soft-deletes existing Design Tab tickets in the group first.
 */
import "dotenv/config";
import { createReadStream } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import { pool, query, withTransaction } from "../src/db/pool.js";
import type { DesignTicketStatus } from "../src/types.js";

const STATUS_ALIASES: Record<string, DesignTicketStatus> = {
  not: "not",
  "not started": "not",
  not_started: "not",
  on: "on",
  "on-track": "on",
  "on track": "on",
  ontrack: "on",
  risk: "risk",
  "at risk": "risk",
  atrisk: "risk",
  review: "review",
  "in review": "review",
  inreview: "review",
  indev: "indev",
  "in development": "indev",
  "in-development": "indev",
  done: "done",
  completed: "done",
  complete: "done",
};

type CsvRow = Record<string, string>;

function normKey(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, "_");
}

function pick(row: CsvRow, ...keys: string[]): string {
  const map = new Map(Object.entries(row).map(([k, v]) => [normKey(k), v ?? ""]));
  for (const key of keys) {
    const v = map.get(normKey(key));
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function parseTicketStatus(raw: string): DesignTicketStatus {
  const key = raw.trim().toLowerCase();
  return STATUS_ALIASES[key] ?? "not";
}

function parseLinks(raw: string): Array<{ label: string; url: string }> {
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (!Array.isArray(arr)) return [];
      return arr
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const label = String((x as { label?: unknown }).label ?? "").trim();
          const url = String((x as { url?: unknown }).url ?? "").trim();
          if (!label || !url) return null;
          return { label, url };
        })
        .filter((x): x is { label: string; url: string } => !!x);
    } catch {
      /* fall through */
    }
  }
  // "Label|https://…; Other|https://…"
  return s
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [label, url] = part.split("|").map((p) => p.trim());
      if (!label || !url) return null;
      return { label, url };
    })
    .filter((x): x is { label: string; url: string } => !!x);
}

function isBucketPerson(person: string): "unassigned" | "completed" | null {
  const p = person.trim().toLowerCase();
  if (p === "unassigned" || p === "") return "unassigned";
  if (p === "completed" || p === "done" || p === "complete") return "completed";
  return null;
}

async function loadCsv(filePath: string): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }),
  );
  for await (const row of parser) {
    rows.push(row as CsvRow);
  }
  return rows;
}

async function resolveGroupId(name: string): Promise<string> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM groups WHERE name ILIKE $1 ORDER BY name LIMIT 5`,
    [name],
  );
  if (!rows[0]) {
    const all = await query<{ name: string }>(`SELECT name FROM groups ORDER BY name`);
    throw new Error(
      `Group not found: ${name}. Existing: ${all.rows.map((r) => r.name).join(", ") || "(none)"}`,
    );
  }
  if (rows.length > 1) {
    console.warn(`[import] multiple groups match "${name}", using ${rows[0].name}`);
  }
  return rows[0].id;
}

async function resolveUsersByName(
  groupId: string,
): Promise<Map<string, { id: string; name: string }>> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT u.id, u.name
       FROM users u
       JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $1`,
    [groupId],
  );
  const map = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    map.set(r.name.trim().toLowerCase(), r);
    // first name alias
    const first = r.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first && !map.has(first)) map.set(first, r);
  }
  return map;
}

async function resolveImporter(groupId: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT u.id FROM users u
      JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $1
     WHERE ug.role IN ('admin', 'owner') OR u.is_super_user = TRUE
     ORDER BY u.is_super_user DESC, u.created_at ASC
     LIMIT 1`,
    [groupId],
  );
  if (rows[0]) return rows[0].id;
  const any = await query<{ id: string }>(
    `SELECT u.id FROM users u
      JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $1
     LIMIT 1`,
    [groupId],
  );
  if (!any.rows[0]) throw new Error("No users in group to set as created_by");
  return any.rows[0].id;
}

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes("--replace");
  const groupFlag = args.indexOf("--group");
  const groupName =
    groupFlag >= 0 && args[groupFlag + 1] ? args[groupFlag + 1]! : "RetailMeNot";
  const fileArg = args.find((a) => !a.startsWith("--") && a !== groupName);
  const filePath = path.resolve(
    fileArg ??
      path.join(
        process.env.HOME ?? "",
        "Downloads",
        "product-design-tickets-export.csv",
      ),
  );

  console.log(`[import] reading ${filePath}`);
  const csvRows = await loadCsv(filePath);
  if (!csvRows.length) throw new Error("CSV is empty");

  const groupId = await resolveGroupId(groupName);
  const users = await resolveUsersByName(groupId);
  const createdBy = await resolveImporter(groupId);
  console.log(`[import] group=${groupName} (${groupId}) rows=${csvRows.length}`);

  const unmatchedPeople = new Set<string>();
  type Prepared = {
    title: string;
    sub: string;
    ticketStatus: DesignTicketStatus;
    jira: string | null;
    links: Array<{ label: string; url: string }>;
    assignedTo: string | null;
    completed: boolean;
    order: number;
    legacyId: string;
  };

  const prepared: Prepared[] = [];
  for (const row of csvRows) {
    const title = pick(row, "title", "name");
    if (!title) continue;
    const person = pick(row, "person", "assignee", "owner");
    const bucket = isBucketPerson(person);
    let assignedTo: string | null = null;
    let completed = bucket === "completed";
    if (!bucket) {
      const user = users.get(person.toLowerCase());
      if (!user) unmatchedPeople.add(person);
      else assignedTo = user.id;
    }

    const orderRaw = pick(row, "order", "position", "rank");
    const order = Number.parseInt(orderRaw, 10);
    const statusRaw = pick(row, "status", "ticket_status");
    let ticketStatus = parseTicketStatus(statusRaw);
    if (completed) ticketStatus = "done";

    prepared.push({
      title,
      sub: pick(row, "sub", "description", "subtitle"),
      ticketStatus,
      jira: pick(row, "jira", "jira_key") || null,
      links: parseLinks(pick(row, "links", "link")),
      assignedTo: bucket === "unassigned" ? null : assignedTo,
      completed,
      order: Number.isFinite(order) ? order : prepared.length,
      legacyId: pick(row, "id", "slug") || title,
    });
  }

  if (unmatchedPeople.size) {
    console.warn(
      `[import] unmatched person names (tickets go Unassigned): ${[...unmatchedPeople].join(", ")}`,
    );
    console.warn(
      `[import] known users: ${[...users.values()].map((u) => u.name).join(", ")}`,
    );
  }

  // Sort by person column then order for stable positions
  prepared.sort((a, b) => {
    const ak = a.completed ? "zz" : a.assignedTo ?? "unassigned";
    const bk = b.completed ? "zz" : b.assignedTo ?? "unassigned";
    if (ak !== bk) return ak.localeCompare(bk);
    return a.order - b.order;
  });

  const result = await withTransaction(async (client) => {
    if (replace) {
      const del = await client.query(
        `UPDATE design_items
            SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
          WHERE group_id = $1
            AND status IN ('next_up', 'in_design', 'completed')
            AND source = 'Design Tab'
            AND project_id IS NULL
            AND simple_feature_id IS NULL`,
        [groupId],
      );
      console.log(`[import] soft-deleted ${del.rowCount ?? 0} existing Design Tab tickets`);
    }

    // Position counters per column key
    const pos = new Map<string, number>();
    let inserted = 0;

    for (const row of prepared) {
      const colKey = row.completed
        ? "completed"
        : row.assignedTo
          ? `user:${row.assignedTo}`
          : "unassigned";
      const position = pos.get(colKey) ?? 0;
      pos.set(colKey, position + 1);

      await client.query(
        `INSERT INTO design_items (
           group_id, name, description, team_id, source,
           status, ticket_status, jira_key, links,
           position, assigned_to, created_by,
           completed_at
         ) VALUES (
           $1, $2, $3, NULL, 'Design Tab',
           $4, $5, $6, $7::jsonb,
           $8, $9, $10,
           $11
         )`,
        [
          groupId,
          row.title,
          row.sub,
          row.completed ? "completed" : "in_design",
          row.ticketStatus,
          row.jira,
          JSON.stringify(row.links),
          position,
          row.assignedTo,
          createdBy,
          row.completed ? new Date() : null,
        ],
      );
      inserted += 1;
    }
    return inserted;
  });

  console.log(`[import] inserted ${result} tickets into ${groupName}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("[import] failed:", err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
