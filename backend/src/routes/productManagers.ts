import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError } from "../middleware/error.js";
import type { KpiRow, SystemRow, TeamRow, UserRow } from "../types.js";
import { scrubUser } from "../types.js";

/**
 * Plan → Team page API. Each product manager has zero or more product
 * areas (teams). KPIs and systems belong to those areas — not to the
 * PM directly. Admin PUT replaces the PM's area list and, for each
 * area, the KPI/system sets on that area.
 */
export const productManagersRouter = Router();

type CatalogRef = { id: string; name: string; color: string; description?: string };

export type ProductManagerArea = {
  id: string;
  name: string;
  color: string;
  description: string;
  kpis: CatalogRef[];
  systems: CatalogRef[];
};

export type ProductManagerView = {
  user: ReturnType<typeof scrubUser>;
  areas: ProductManagerArea[];
};

async function loadProductManagers(groupId: string): Promise<ProductManagerView[]> {
  const { rows: users } = await query<UserRow>(
    `SELECT u.*
       FROM users u
       JOIN user_groups ug ON ug.user_id = u.id AND ug.group_id = $1
      WHERE ug.is_product_manager = TRUE
      ORDER BY u.name ASC`,
    [groupId],
  );
  if (!users.length) return [];

  const userIds = users.map((u) => u.id);

  const { rows: areaLinks } = await query<{
    user_id: string;
    id: string;
    name: string;
    color: string;
    description: string;
  }>(
    `SELECT pmt.user_id, t.id, t.name, t.color, t.description
       FROM product_manager_teams pmt
       JOIN teams t ON t.id = pmt.team_id
      WHERE pmt.user_id = ANY($1::uuid[])
        AND t.group_id = $2
      ORDER BY t."order" ASC, t.name ASC`,
    [userIds, groupId],
  );

  const teamIds = [...new Set(areaLinks.map((a) => a.id))];
  const kpisByTeam = new Map<string, CatalogRef[]>();
  const systemsByTeam = new Map<string, CatalogRef[]>();

  if (teamIds.length) {
    const { rows: kpiLinks } = await query<{
      team_id: string;
      id: string;
      name: string;
      color: string;
      description: string;
    }>(
      `SELECT tk.team_id, k.id, k.name, k.color, k.description
         FROM team_kpis tk
         JOIN kpis k ON k.id = tk.kpi_id
        WHERE tk.team_id = ANY($1::uuid[])
          AND k.group_id = $2
        ORDER BY k."order" ASC, k.name ASC`,
      [teamIds, groupId],
    );
    for (const r of kpiLinks) {
      const arr = kpisByTeam.get(r.team_id) ?? [];
      arr.push({ id: r.id, name: r.name, color: r.color, description: r.description });
      kpisByTeam.set(r.team_id, arr);
    }

    const { rows: systemLinks } = await query<{
      team_id: string;
      id: string;
      name: string;
      color: string;
      description: string;
    }>(
      `SELECT s.team_id, s.id, s.name, s.color, s.description
         FROM systems s
        WHERE s.team_id = ANY($1::uuid[])
          AND s.group_id = $2
        ORDER BY s."order" ASC, s.name ASC`,
      [teamIds, groupId],
    );
    for (const r of systemLinks) {
      const arr = systemsByTeam.get(r.team_id) ?? [];
      arr.push({ id: r.id, name: r.name, color: r.color, description: r.description });
      systemsByTeam.set(r.team_id, arr);
    }
  }

  const areasByUser = new Map<string, ProductManagerArea[]>();
  for (const a of areaLinks) {
    const arr = areasByUser.get(a.user_id) ?? [];
    arr.push({
      id: a.id,
      name: a.name,
      color: a.color,
      description: a.description ?? "",
      kpis: kpisByTeam.get(a.id) ?? [],
      systems: systemsByTeam.get(a.id) ?? [],
    });
    areasByUser.set(a.user_id, arr);
  }

  return users.map((u) => ({
    user: scrubUser(u),
    areas: areasByUser.get(u.id) ?? [],
  }));
}

productManagersRouter.get("/", async (req, res) => {
  res.json(await loadProductManagers(req.groupId!));
});

const areaAssignSchema = z.object({
  team_id: z.string().uuid(),
  kpi_ids: z.array(z.string().uuid()),
  system_ids: z.array(z.string().uuid()),
});

const assignSchema = z.object({
  /** Product areas this PM owns (order preserved). */
  team_ids: z.array(z.string().uuid()),
  /** Per-area KPI/system sets. Areas not listed keep existing assignments. */
  areas: z.array(areaAssignSchema).optional().default([]),
});

productManagersRouter.put("/:userId", requireAdmin, async (req, res) => {
  const body = assignSchema.parse(req.body);
  const groupId = req.groupId!;
  const userId = String(req.params.userId);

  const { rows: pmRows } = await query<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM user_groups ug
      WHERE ug.user_id = $1
        AND ug.group_id = $2
        AND ug.is_product_manager = TRUE`,
    [userId, groupId],
  );
  if (!pmRows[0]) {
    throw new HttpError(400, "user is not a product manager in this group");
  }

  if (body.team_ids.length) {
    const { rows } = await query<TeamRow>(
      `SELECT id FROM teams WHERE group_id = $1 AND id = ANY($2::uuid[])`,
      [groupId, body.team_ids],
    );
    if (rows.length !== body.team_ids.length) {
      throw new HttpError(400, "one or more team_ids are invalid for this group");
    }
  }

  const teamIdSet = new Set(body.team_ids);
  for (const area of body.areas) {
    if (!teamIdSet.has(area.team_id)) {
      throw new HttpError(400, "areas[].team_id must be included in team_ids");
    }
  }

  const allKpiIds = [...new Set(body.areas.flatMap((a) => a.kpi_ids))];
  const allSystemIds = [...new Set(body.areas.flatMap((a) => a.system_ids))];

  if (allKpiIds.length) {
    const { rows } = await query<KpiRow>(
      `SELECT id FROM kpis WHERE group_id = $1 AND id = ANY($2::uuid[])`,
      [groupId, allKpiIds],
    );
    if (rows.length !== allKpiIds.length) {
      throw new HttpError(400, "one or more kpi_ids are invalid for this group");
    }
  }
  if (allSystemIds.length) {
    const { rows } = await query<SystemRow>(
      `SELECT id FROM systems WHERE group_id = $1 AND id = ANY($2::uuid[])`,
      [groupId, allSystemIds],
    );
    if (rows.length !== allSystemIds.length) {
      throw new HttpError(400, "one or more system_ids are invalid for this group");
    }
  }

  // A system may only belong to one area — reject duplicates in the payload.
  const systemOwner = new Map<string, string>();
  for (const area of body.areas) {
    for (const sid of area.system_ids) {
      const prev = systemOwner.get(sid);
      if (prev && prev !== area.team_id) {
        throw new HttpError(400, "a system can only be assigned to one product area");
      }
      systemOwner.set(sid, area.team_id);
    }
  }

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM product_manager_teams WHERE user_id = $1`, [userId]);
    for (const teamId of body.team_ids) {
      await client.query(
        `INSERT INTO product_manager_teams (user_id, team_id) VALUES ($1, $2)`,
        [userId, teamId],
      );
    }

    for (const area of body.areas) {
      await client.query(`DELETE FROM team_kpis WHERE team_id = $1`, [area.team_id]);
      for (const kpiId of area.kpi_ids) {
        await client.query(
          `INSERT INTO team_kpis (team_id, kpi_id) VALUES ($1, $2)`,
          [area.team_id, kpiId],
        );
      }

      // Clear systems currently on this area, then claim the requested set
      // (may steal from another area — admin override).
      await client.query(
        `UPDATE systems
            SET team_id = NULL, updated_at = NOW()
          WHERE team_id = $1 AND group_id = $2`,
        [area.team_id, groupId],
      );
      if (area.system_ids.length) {
        await client.query(
          `UPDATE systems
              SET team_id = $1, updated_at = NOW()
            WHERE id = ANY($2::uuid[]) AND group_id = $3`,
          [area.team_id, area.system_ids, groupId],
        );
      }
    }
  });

  const all = await loadProductManagers(groupId);
  const updated = all.find((p) => p.user?.id === userId);
  if (!updated) throw new HttpError(404, "product manager not found");
  res.json(updated);
});
