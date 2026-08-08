import { pool } from "../src/db/pool.js";

async function main() {
  const client = await pool.connect();
  try {
    const epic = await client.query(
      "SELECT id, title, group_id FROM projects WHERE type = $1 AND deleted_at IS NULL LIMIT 1",
      ["epic"],
    );
    const e = epic.rows[0];
    if (!e) {
      console.log("no epic found");
      return;
    }
    const sub = await client.query(
      "SELECT id, parent_id, type FROM projects WHERE parent_id = $1 AND type = $2 LIMIT 1",
      [e.id, "subtask"],
    );
    const s = sub.rows[0];
    console.log("epic", e.id, e.title);
    console.log("subtask", s?.id, s?.parent_id);
    if (!s) {
      console.log("no direct subtask");
      return;
    }

    const week = "2026-08-04";
    const subtaskJson = JSON.stringify([{ project_id: s.id, update_text: "test subtask note" }]);
    await client.query("DELETE FROM weekly_status_updates WHERE project_id = $1 AND week_of = $2", [
      e.id,
      week,
    ]);
    const ins = await client.query(
      `INSERT INTO weekly_status_updates
         (project_id, submitted_by_user_id, original_submitted_by_user_id, week_of, health_flag,
          executive_summary, detailed_update, subtask_updates, completed, due_at, submitted_at)
       VALUES ($1,$2,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,NOW(),NOW()) RETURNING *`,
      [e.id, e.id, week, "green", "summary", "[]", subtaskJson, true],
    );
    console.log("INSERT ok", ins.rows[0].subtask_updates);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
