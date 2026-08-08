import type { PoolClient } from "pg";
import type { SimpleFeatureRow, SwimLaneRow } from "../types.js";

type UpsertArgs = {
  groupId: string;
  userId: string;
  name: string;
  description: string;
  teamId: string | null;
  source: string;
  projectId?: string | null;
  simpleFeatureId?: string | null;
  atTop: boolean;
};

async function nextUpPosition(
  client: PoolClient,
  groupId: string,
  atTop: boolean,
): Promise<number> {
  if (atTop) {
    await client.query(
      `UPDATE design_items
          SET position = position + 1, updated_at = NOW()
        WHERE group_id = $1 AND status = 'next_up'`,
      [groupId],
    );
    return 0;
  }
  const { rows } = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next
       FROM design_items
      WHERE group_id = $1 AND status = 'next_up'`,
    [groupId],
  );
  return rows[0]?.next ?? 0;
}

async function upsertDesignItem(client: PoolClient, args: UpsertArgs): Promise<void> {
  const position = await nextUpPosition(client, args.groupId, args.atTop);

  let existingId: string | null = null;
  if (args.projectId) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM design_items WHERE group_id = $1 AND project_id = $2`,
      [args.groupId, args.projectId],
    );
    existingId = rows[0]?.id ?? null;
  } else if (args.simpleFeatureId) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM design_items WHERE group_id = $1 AND simple_feature_id = $2`,
      [args.groupId, args.simpleFeatureId],
    );
    existingId = rows[0]?.id ?? null;
  }

  if (existingId) {
    await client.query(
      `UPDATE design_items
          SET name = $1,
              description = $2,
              team_id = $3,
              source = $4,
              status = 'next_up',
              position = $5,
              deleted_at = NULL,
              completed_at = NULL,
              updated_at = NOW()
        WHERE id = $6`,
      [
        args.name,
        args.description,
        args.teamId,
        args.source,
        position,
        existingId,
      ],
    );
    return;
  }

  await client.query(
    `INSERT INTO design_items (
       group_id, name, description, team_id, source,
       status, position, created_by, project_id, simple_feature_id
     ) VALUES ($1, $2, $3, $4, $5, 'next_up', $6, $7, $8, $9)`,
    [
      args.groupId,
      args.name,
      args.description,
      args.teamId,
      args.source,
      position,
      args.userId,
      args.projectId ?? null,
      args.simpleFeatureId ?? null,
    ],
  );
}

export async function removeDesignItemForProject(
  client: PoolClient,
  groupId: string,
  projectId: string,
): Promise<void> {
  await client.query(
    `UPDATE design_items
        SET status = 'deleted',
            deleted_at = NOW(),
            updated_at = NOW()
      WHERE group_id = $1
        AND project_id = $2
        AND status IN ('next_up', 'in_design')`,
    [groupId, projectId],
  );
}

export async function removeDesignItemForSimpleFeature(
  client: PoolClient,
  groupId: string,
  simpleFeatureId: string,
): Promise<void> {
  await client.query(
    `UPDATE design_items
        SET status = 'deleted',
            deleted_at = NOW(),
            updated_at = NOW()
      WHERE group_id = $1
        AND simple_feature_id = $2
        AND status IN ('next_up', 'in_design')`,
    [groupId, simpleFeatureId],
  );
}

export async function syncDesignQueueAfterProjectLaneChange(
  client: PoolClient,
  args: {
    groupId: string;
    projectId: string;
    toLaneId: string;
    userId: string;
  },
): Promise<void> {
  const { rows: laneRows } = await client.query<SwimLaneRow>(
    `SELECT * FROM swim_lanes WHERE id = $1 AND group_id = $2`,
    [args.toLaneId, args.groupId],
  );
  const lane = laneRows[0];
  if (!lane) return;

  if (lane.is_archive || lane.is_terminal) {
    await removeDesignItemForProject(client, args.groupId, args.projectId);
    return;
  }

  if (!lane.add_to_design_queue) return;

  const { rows: projectRows } = await client.query<{
    title: string;
    description: string;
  }>(
    `SELECT title, description FROM projects
      WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
    [args.projectId, args.groupId],
  );
  const project = projectRows[0];
  if (!project) return;

  const { rows: teamRows } = await client.query<{ team_id: string }>(
    `SELECT team_id FROM project_teams
      WHERE project_id = $1
      ORDER BY position ASC
      LIMIT 1`,
    [args.projectId],
  );

  await upsertDesignItem(client, {
    groupId: args.groupId,
    userId: args.userId,
    name: project.title,
    description: project.description ?? "",
    teamId: teamRows[0]?.team_id ?? null,
    source: lane.name,
    projectId: args.projectId,
    atTop: false,
  });
}

export async function syncDesignQueueForSimpleFeature(
  client: PoolClient,
  feature: SimpleFeatureRow,
  userId: string,
): Promise<void> {
  if (
    feature.status === "completed" ||
    feature.status === "deleted" ||
    !feature.needs_design
  ) {
    await removeDesignItemForSimpleFeature(client, feature.group_id, feature.id);
    return;
  }

  if (feature.status !== "next_up" && feature.status !== "in_development") return;

  await upsertDesignItem(client, {
    groupId: feature.group_id,
    userId,
    name: feature.name,
    description: feature.description,
    teamId: feature.team_id,
    source: "Simple Feature",
    simpleFeatureId: feature.id,
    atTop: false,
  });
}
