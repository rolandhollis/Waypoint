/**
 * One-shot: ensure design swim-lane users exist in a group, then import
 * the Product Design Tickets CSV. Intended for production via fly proxy.
 *
 * Usage (with DATABASE_URL pointing at prod via proxy):
 *   npx tsx scripts/ensure_design_users_and_import.ts [csv] [--group RetailMeNot] [--replace]
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction } from "../src/db/pool.js";

const DESIGNERS = [
  { name: "Doug", email: "doug@waypoint.example" },
  { name: "Isa", email: "isa@waypoint.example" },
  { name: "JiaJia", email: "jiajia@waypoint.example" },
] as const;

const COLORS = ["#0EA5E9", "#9333EA", "#EA580C"] as const;

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
  return rows[0].id;
}

async function ensureDesigners(groupId: string): Promise<void> {
  for (let i = 0; i < DESIGNERS.length; i++) {
    const d = DESIGNERS[i]!;
    const color = COLORS[i]!;

    const { rows: byName } = await query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE lower(name) = lower($1) LIMIT 1`,
      [d.name],
    );
    let userId = byName[0]?.id ?? null;

    if (!userId) {
      const { rows: byEmail } = await query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
        [d.email],
      );
      userId = byEmail[0]?.id ?? null;
    }

    if (!userId) {
      const created = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, name, role, color, capacity, password_hash, password_updated_at)
           VALUES ($1, $2, 'owner', $3, 3, NULL, NULL)
           RETURNING id`,
          [d.email, d.name, color],
        );
        const id = rows[0]!.id;
        await client.query(
          `INSERT INTO user_groups (user_id, group_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (user_id, group_id) DO NOTHING`,
          [id, groupId],
        );
        return id;
      });
      userId = created;
      console.log(`[prep] created user ${d.name} <${d.email}>`);
    } else {
      await query(
        `INSERT INTO user_groups (user_id, group_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (user_id, group_id) DO NOTHING`,
        [userId, groupId],
      );
      console.log(`[prep] ensured membership for ${d.name}`);
    }

    // Ensure a design board lane exists for this user.
    await query(
      `INSERT INTO design_board_lanes (group_id, user_id, "order")
       SELECT $1, $2, COALESCE((SELECT MAX("order") + 1 FROM design_board_lanes WHERE group_id = $1), 0)
       WHERE NOT EXISTS (
         SELECT 1 FROM design_board_lanes WHERE group_id = $1 AND user_id = $2
       )`,
      [groupId, userId],
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const groupFlag = args.indexOf("--group");
  const groupName =
    groupFlag >= 0 && args[groupFlag + 1] ? args[groupFlag + 1]! : "RetailMeNot";
  const replace = args.includes("--replace");
  const fileArg = args.find((a) => !a.startsWith("--") && a !== groupName);
  const csvPath = path.resolve(
    fileArg ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../docs/product-design-tickets-export.csv",
      ),
  );

  console.log(`[prep] group=${groupName}`);
  const groupId = await resolveGroupId(groupName);
  await ensureDesigners(groupId);

  const before = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM design_items
      WHERE group_id = $1 AND status <> 'deleted'`,
    [groupId],
  );
  console.log(`[prep] existing non-deleted design items: ${before.rows[0]?.n ?? 0}`);
  await pool.end();

  const importArgs = [csvPath, "--group", groupName];
  if (replace) importArgs.push("--replace");

  const importScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "import_design_tickets.ts",
  );
  console.log(`[prep] running import…`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", importScript, ...importArgs], {
      stdio: "inherit",
      env: process.env,
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
      shell: true,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`import exited ${code}`));
    });
  });
}

main().catch(async (err) => {
  console.error("[prep] failed:", err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
