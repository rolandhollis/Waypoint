#!/usr/bin/env node
/**
 * One-shot: sync RetailMeNot product areas / KPIs / systems / PM
 * assignments from the Product Org CSV into production (or any DB).
 *
 * Usage:
 *   DATABASE_URL=... node scripts/sync-product-org-from-csv.mjs [--apply] [path/to.csv]
 *
 * Default is dry-run. Pass --apply to write.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../backend/package.json"),
);
const pg = require("pg");

const APPLY = process.argv.includes("--apply");
const csvPath =
  process.argv.find((a) => a.endsWith(".csv")) ??
  "/Users/rolandhollis/Downloads/Product Org - Oct 26 - Sheet1.csv";

const GROUP_NAME = "RetailMeNot";

const TEAM_PALETTE = [
  "#3B82F6",
  "#EF4444",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#14B8A6",
  "#F97316",
  "#0EA5E9",
  "#84CC16",
];
const KPI_PALETTE = [
  "#0EA5E9",
  "#22C55E",
  "#F59E0B",
  "#EF4444",
  "#A855F7",
  "#EC4899",
  "#14B8A6",
  "#F97316",
];
const SYSTEM_PALETTE = [
  "#64748B",
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#14B8A6",
  "#F97316",
];

/** Prefer matching these existing prod teams before creating new ones. */
const TEAM_ALIASES = {
  martech: ["martech", "mar tech"],
  "search recs personalization": ["personalization", "search recs personalization", "agentic search"],
  "product deals": ["product deals"],
  "rewards platform": ["rewards platform"],
  "mobile apps": ["mobile apps", "mobile app"],
  extensions: ["extensions"],
  "rewards program": ["rewards program", "loyalty"],
  "a b testing": ["a b testing", "ab testing"],
  web: ["web", "seo"],
};

/** Owner token (sheet) → email substrings to match in users. */
const OWNER_EMAIL_HINTS = {
  andrea: ["andrea.dicastro"],
  roland: ["roland.hollis"],
  dom: ["dom.cervasio"],
  lauren: ["lauren.wendorf"],
  daniela: ["daniela.steiner"],
  berett: ["berett.thompson"],
  cilla: ["cilla.leung"],
};

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function tidyName(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/Velocuty/gi, "Velocity")
    .replace(/Comission/gi, "Commission");
}

function parseOrg(rows) {
  const header = rows[0] ?? [];
  const ownerRow = rows[1] ?? [];
  const areas = [];
  for (let c = 1; c < header.length; c++) {
    const name = tidyName(header[c]);
    if (!name) continue;
    areas.push({
      col: c,
      name,
      ownersRaw: tidyName(ownerRow[c]),
      owners: tidyName(ownerRow[c])
        .split(/[\/,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      kpis: [],
      systems: [],
    });
  }

  const isNote = (s) =>
    /where would preference|pref center is related|unifed user profile/i.test(s);

  let mode = null; // 'kpis' | 'systems' | null
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const cells = row.map(tidyName);
    const label = cells[0] ?? "";
    if (cells.every((c) => !c)) continue;
    // Footer commentary (often parked in the Martech column with a blank label).
    if (cells.some(isNote)) {
      mode = null;
      continue;
    }
    if (/^kpis?$/i.test(label)) mode = "kpis";
    else if (/^systems?$/i.test(label)) mode = "systems";

    if (!mode) continue;
    for (const area of areas) {
      const val = cells[area.col] ?? "";
      // First KPI/Systems row also has the section label in col0; still take col values.
      if (!val || isNote(val)) continue;
      if (mode === "kpis") area.kpis.push(val);
      else area.systems.push(val);
    }
  }
  return areas;
}

function pickColor(palette, used) {
  const taken = new Set([...used].map((c) => c.toLowerCase()));
  for (const c of palette) {
    if (!taken.has(c.toLowerCase())) return c;
  }
  return palette[used.size % palette.length];
}

function findTeam(existing, sheetName) {
  const key = norm(sheetName);
  const aliases = TEAM_ALIASES[key] ?? [key];
  for (const a of aliases) {
    const hit = existing.find((t) => norm(t.name) === a);
    if (hit) return hit;
  }
  // fuzzy contains
  for (const a of aliases) {
    const hit = existing.find((t) => {
      const n = norm(t.name);
      return n.includes(a) || a.includes(n);
    });
    if (hit) return hit;
  }
  return null;
}

function resolveUser(users, ownerToken) {
  const key = norm(ownerToken).split(" ")[0];
  const hints = OWNER_EMAIL_HINTS[key] ?? [];
  for (const hint of hints) {
    const hit = users.find((u) => u.email.toLowerCase().includes(hint));
    if (hit) return hit;
  }
  const byName = users.find((u) => norm(u.name).split(" ")[0] === key);
  return byName ?? null;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }
  const raw = fs.readFileSync(csvPath, "utf8");
  const areas = parseOrg(parseCsv(raw));
  console.log(`CSV: ${path.basename(csvPath)} → ${areas.length} areas (${APPLY ? "APPLY" : "dry-run"})`);
  for (const a of areas) {
    console.log(
      `  • ${a.name} [${a.owners.join(", ")}] kpis=${a.kpis.length} systems=${a.systems.length}`,
    );
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const { rows: groups } = await client.query(`SELECT id, name FROM groups WHERE name = $1`, [
      GROUP_NAME,
    ]);
    if (!groups[0]) throw new Error(`group ${GROUP_NAME} not found`);
    const groupId = groups[0].id;
    console.log(`\nGroup ${GROUP_NAME} ${groupId}`);

    const { rows: teams } = await client.query(
      `SELECT id, name, color, description, "order" FROM teams WHERE group_id = $1 ORDER BY "order", name`,
      [groupId],
    );
    const { rows: kpis } = await client.query(
      `SELECT id, name, color FROM kpis WHERE group_id = $1`,
      [groupId],
    );
    const { rows: systems } = await client.query(
      `SELECT id, name, color, team_id FROM systems WHERE group_id = $1`,
      [groupId],
    );
    const { rows: users } = await client.query(
      `SELECT u.id, u.name, u.email, COALESCE(ug.is_product_manager, FALSE) AS is_product_manager
         FROM users u
         JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $1
        ORDER BY u.name`,
      [groupId],
    );

    const plan = {
      teamCreates: [],
      teamRenames: [],
      kpiCreates: [],
      systemCreates: [],
      systemReassigns: [],
      pmFlags: [],
      pmAssignments: [], // {user, team}
      teamKpiLinks: [], // {team, kpi}
    };

    const teamBySheet = new Map();
    let nextTeamOrder = teams.reduce((m, t) => Math.max(m, t.order ?? 0), -1) + 1;
    const usedTeamColors = new Set(teams.map((t) => t.color));

    for (const area of areas) {
      let team = findTeam(teams, area.name);
      if (!team) {
        // also check already-planned creates
        const planned = plan.teamCreates.find((t) => norm(t.name) === norm(area.name));
        if (planned) {
          team = planned;
        } else {
          const color = pickColor(TEAM_PALETTE, usedTeamColors);
          usedTeamColors.add(color);
          team = {
            id: null,
            name: area.name,
            color,
            order: nextTeamOrder++,
            _new: true,
          };
          plan.teamCreates.push(team);
        }
      } else if (team.name !== area.name) {
        plan.teamRenames.push({ from: team.name, to: area.name, id: team.id });
        team = { ...team, name: area.name };
      }
      teamBySheet.set(area.name, { team, area });
    }

    const kpiByNorm = new Map(kpis.map((k) => [norm(k.name), k]));
    const usedKpiColors = new Set(kpis.map((k) => k.color));
    const systemByNorm = new Map(systems.map((s) => [norm(s.name), s]));
    const usedSysColors = new Set(systems.map((s) => s.color));

    const allOwnerIds = new Set();

    for (const { team, area } of teamBySheet.values()) {
      for (const ownerToken of area.owners) {
        const user = resolveUser(users, ownerToken);
        if (!user) {
          console.warn(`  ! owner not found: ${ownerToken} for ${area.name}`);
          continue;
        }
        allOwnerIds.add(user.id);
        if (!user.is_product_manager) {
          plan.pmFlags.push(user);
          user.is_product_manager = true;
        }
        plan.pmAssignments.push({ user, teamName: area.name, team });
      }

      for (const kpiName of area.kpis) {
        let kpi = kpiByNorm.get(norm(kpiName));
        if (!kpi) {
          const color = pickColor(KPI_PALETTE, usedKpiColors);
          usedKpiColors.add(color);
          kpi = { id: null, name: kpiName, color, _new: true };
          plan.kpiCreates.push(kpi);
          kpiByNorm.set(norm(kpiName), kpi);
        } else if (kpi.name !== kpiName && kpi._new) {
          // keep first spelling
        }
        plan.teamKpiLinks.push({ team, kpi, teamName: area.name, kpiName });
      }

      for (const sysName of area.systems) {
        let sys = systemByNorm.get(norm(sysName));
        if (!sys) {
          const color = pickColor(SYSTEM_PALETTE, usedSysColors);
          usedSysColors.add(color);
          sys = { id: null, name: sysName, color, team_id: null, _new: true };
          plan.systemCreates.push(sys);
          systemByNorm.set(norm(sysName), sys);
        }
        plan.systemReassigns.push({ sys, team, teamName: area.name });
      }
    }

    // Deduplicate pmFlags / kpiCreates by identity
    plan.pmFlags = [...new Map(plan.pmFlags.map((u) => [u.id, u])).values()];
    plan.kpiCreates = [...new Map(plan.kpiCreates.map((k) => [norm(k.name), k])).values()];
    plan.systemCreates = [...new Map(plan.systemCreates.map((s) => [norm(s.name), s])).values()];

    console.log("\nPlan:");
    console.log(`  create teams (${plan.teamCreates.length}):`, plan.teamCreates.map((t) => t.name));
    console.log(
      `  rename teams (${plan.teamRenames.length}):`,
      plan.teamRenames.map((r) => `${r.from} → ${r.to}`),
    );
    console.log(`  create kpis (${plan.kpiCreates.length}):`, plan.kpiCreates.map((k) => k.name));
    console.log(
      `  create systems (${plan.systemCreates.length}):`,
      plan.systemCreates.map((s) => s.name),
    );
    console.log(
      `  PM flags (${plan.pmFlags.length}):`,
      plan.pmFlags.map((u) => u.name),
    );
    console.log(`  PM↔area links: ${plan.pmAssignments.length}`);
    console.log(`  team↔KPI links: ${plan.teamKpiLinks.length}`);
    console.log(`  system↔area assigns: ${plan.systemReassigns.length}`);

    if (!APPLY) {
      console.log("\nDry-run only. Re-run with --apply to write.");
      return;
    }

    await client.query("BEGIN");

    // Create teams
    for (const t of plan.teamCreates) {
      const { rows } = await client.query(
        `INSERT INTO teams (group_id, name, description, color, "order")
         VALUES ($1, $2, '', $3, $4) RETURNING id, name, color, "order"`,
        [groupId, t.name, t.color, t.order],
      );
      Object.assign(t, rows[0]);
      teams.push(rows[0]);
      console.log(`  + team ${rows[0].name}`);
    }

    // Renames
    for (const r of plan.teamRenames) {
      await client.query(`UPDATE teams SET name = $1, updated_at = NOW() WHERE id = $2`, [
        r.to,
        r.id,
      ]);
      console.log(`  ~ team ${r.from} → ${r.to}`);
    }

    // Refresh team refs after create/rename
    for (const [sheetName, entry] of teamBySheet) {
      if (!entry.team.id) {
        const created = plan.teamCreates.find((t) => norm(t.name) === norm(sheetName));
        entry.team = created;
      } else if (entry.team.name !== sheetName) {
        entry.team = { ...entry.team, name: sheetName };
      }
    }

    // Create KPIs
    let nextKpiOrder =
      (
        await client.query(`SELECT COALESCE(MAX("order"), -1) + 1 AS n FROM kpis WHERE group_id = $1`, [
          groupId,
        ])
      ).rows[0].n ?? 0;
    for (const k of plan.kpiCreates) {
      const { rows } = await client.query(
        `INSERT INTO kpis (group_id, name, description, color, "order")
         VALUES ($1, $2, '', $3, $4) RETURNING id, name, color`,
        [groupId, k.name, k.color, nextKpiOrder++],
      );
      Object.assign(k, rows[0]);
      kpiByNorm.set(norm(k.name), rows[0]);
      console.log(`  + kpi ${rows[0].name}`);
    }

    // Create systems
    let nextSysOrder =
      (
        await client.query(
          `SELECT COALESCE(MAX("order"), -1) + 1 AS n FROM systems WHERE group_id = $1`,
          [groupId],
        )
      ).rows[0].n ?? 0;
    for (const s of plan.systemCreates) {
      const { rows } = await client.query(
        `INSERT INTO systems (group_id, name, description, color, "order")
         VALUES ($1, $2, '', $3, $4) RETURNING id, name, color, team_id`,
        [groupId, s.name, s.color, nextSysOrder++],
      );
      Object.assign(s, rows[0]);
      systemByNorm.set(norm(s.name), rows[0]);
      console.log(`  + system ${rows[0].name}`);
    }

    // PM flags
    for (const u of plan.pmFlags) {
      await client.query(
        `UPDATE user_groups SET is_product_manager = TRUE WHERE user_id = $1 AND group_id = $2`,
        [u.id, groupId],
      );
      console.log(`  ✓ PM flag ${u.name}`);
    }
    // Ensure all owners from sheet are flagged (including already-true)
    for (const { user } of plan.pmAssignments) {
      await client.query(
        `UPDATE user_groups SET is_product_manager = TRUE WHERE user_id = $1 AND group_id = $2`,
        [user.id, groupId],
      );
    }

    // Replace PM team links for owners we're assigning (only sheet owners)
    const ownerIds = [...new Set(plan.pmAssignments.map((a) => a.user.id))];
    if (ownerIds.length) {
      await client.query(`DELETE FROM product_manager_teams WHERE user_id = ANY($1::uuid[])`, [
        ownerIds,
      ]);
    }
    const seenPmTeam = new Set();
    for (const a of plan.pmAssignments) {
      const teamId = teamBySheet.get(a.teamName)?.team?.id ?? a.team.id;
      if (!teamId) throw new Error(`missing team id for ${a.teamName}`);
      const key = `${a.user.id}:${teamId}`;
      if (seenPmTeam.has(key)) continue;
      seenPmTeam.add(key);
      await client.query(
        `INSERT INTO product_manager_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [a.user.id, teamId],
      );
      console.log(`  ✓ ${a.user.name} → ${a.teamName}`);
    }

    // Replace team_kpis for sheet teams
    const sheetTeamIds = [...teamBySheet.values()].map((e) => e.team.id).filter(Boolean);
    if (sheetTeamIds.length) {
      await client.query(`DELETE FROM team_kpis WHERE team_id = ANY($1::uuid[])`, [sheetTeamIds]);
    }
    const seenTk = new Set();
    for (const link of plan.teamKpiLinks) {
      const teamId = teamBySheet.get(link.teamName)?.team?.id;
      const kpi = kpiByNorm.get(norm(link.kpiName));
      if (!teamId || !kpi?.id) throw new Error(`bad kpi link ${link.teamName} / ${link.kpiName}`);
      const key = `${teamId}:${kpi.id}`;
      if (seenTk.has(key)) continue;
      seenTk.add(key);
      await client.query(
        `INSERT INTO team_kpis (team_id, kpi_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [teamId, kpi.id],
      );
    }
    console.log(`  ✓ team_kpis links: ${seenTk.size}`);

    // Assign systems to teams
    for (const a of plan.systemReassigns) {
      const teamId = teamBySheet.get(a.teamName)?.team?.id;
      const sys = systemByNorm.get(norm(a.sys.name));
      if (!teamId || !sys?.id) throw new Error(`bad system assign ${a.sys.name}`);
      await client.query(
        `UPDATE systems SET team_id = $1, updated_at = NOW() WHERE id = $2`,
        [teamId, sys.id],
      );
    }
    console.log(`  ✓ systems assigned: ${plan.systemReassigns.length}`);

    await client.query("COMMIT");
    console.log("\nApplied successfully.");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
