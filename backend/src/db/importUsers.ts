import { readFileSync } from "node:fs";
import { pool, withTransaction } from "./pool.js";

/**
 * One-shot user importer for real-user rollout. Reads a JSON file of
 * `{ email, name, role, color? }` records and upserts each by lower(email).
 *
 * Usage:
 *   npm run import-users -- path/to/users.json
 *   npm run import-users -- path/to/users.json --dry-run
 *
 * JSON schema (array of records):
 *   [
 *     { "email": "person@example.com", "name": "Person Name", "role": "owner" },
 *     { "email": "admin@example.com",  "name": "Admin Name",  "role": "admin", "color": "#E01F2D" }
 *   ]
 *
 * Existing users are updated (name, role, color) and never deleted; to
 * remove a user, either PATCH their role to viewer or delete manually
 * from the DB. Case-insensitive on email.
 */

type Role = "admin" | "owner" | "viewer";
type Record = { email: string; name: string; role: Role; color?: string };

const DEFAULT_COLORS = [
  "#E01F2D", "#7c3aed", "#0891b2", "#16a34a", "#f59e0b",
  "#0ea5e9", "#ec4899", "#14b8a6", "#a855f7", "#64748b",
];

function parseArgs(argv: string[]): { file: string; dryRun: boolean } {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!file) {
    console.error("usage: import-users <path/to/users.json> [--dry-run]");
    process.exit(2);
  }
  return { file, dryRun };
}

function validate(records: unknown): Record[] {
  if (!Array.isArray(records)) {
    throw new Error("expected top-level JSON array");
  }
  const out: Record[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as Record;
    if (!r || typeof r !== "object") throw new Error(`record ${i} is not an object`);
    if (typeof r.email !== "string" || !r.email.includes("@")) {
      throw new Error(`record ${i} has invalid email: ${JSON.stringify(r.email)}`);
    }
    if (typeof r.name !== "string" || !r.name.trim()) {
      throw new Error(`record ${i} has invalid name`);
    }
    if (!["admin", "owner", "viewer"].includes(r.role)) {
      throw new Error(`record ${i} has invalid role: ${JSON.stringify(r.role)}`);
    }
    if (r.color !== undefined && typeof r.color !== "string") {
      throw new Error(`record ${i} has invalid color`);
    }
    out.push(r);
  }
  return out;
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv);
  const raw = readFileSync(file, "utf8");
  const records = validate(JSON.parse(raw));
  console.log(`Loaded ${records.length} user record(s) from ${file}${dryRun ? " (dry-run)" : ""}`);

  await withTransaction(async (client) => {
    let created = 0;
    let updated = 0;
    for (let i = 0; i < records.length; i++) {
      const r = records[i]!;
      const color = r.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]!;

      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [r.email],
      );

      if (existing[0]) {
        if (dryRun) {
          console.log(`  UPDATE ${r.email} → role=${r.role}, name="${r.name}"`);
        } else {
          await client.query(
            `UPDATE users SET name = $1, role = $2, color = $3, updated_at = NOW()
              WHERE id = $4`,
            [r.name, r.role, color, existing[0].id],
          );
        }
        updated++;
      } else {
        if (dryRun) {
          console.log(`  CREATE ${r.email} → role=${r.role}, name="${r.name}", color=${color}`);
        } else {
          await client.query(
            `INSERT INTO users (email, name, role, color) VALUES ($1, $2, $3, $4)`,
            [r.email, r.name, r.role, color],
          );
        }
        created++;
      }
    }

    if (dryRun) {
      console.log(`\nDry-run summary: would create ${created}, update ${updated}`);
      throw new Error("__dry_run__"); // roll the tx back
    }
    console.log(`\nDone. created=${created}, updated=${updated}`);
  }).catch((err) => {
    if (err instanceof Error && err.message === "__dry_run__") return;
    throw err;
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
