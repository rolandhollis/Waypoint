import type { PoolClient } from "pg";

/** Default A/B Testing columns, left → right. Seeded per group. */
export const DEFAULT_AB_TEST_LANES: ReadonlyArray<{
  name: string;
  is_terminal: boolean;
}> = [
  { name: "Backlog (ideas)", is_terminal: false },
  { name: "Prioritized (next in the queue for Scoping & Hypothesis)", is_terminal: false },
  { name: "Design", is_terminal: false },
  { name: "Ready to build", is_terminal: false },
  { name: "In Development", is_terminal: false },
  { name: "Live", is_terminal: false },
  { name: "End", is_terminal: false },
  { name: "Analysis", is_terminal: false },
  { name: "Cross-team signoffs", is_terminal: false },
  { name: "Complete/Archive", is_terminal: true },
];

/** Insert the default stage columns if this group has none yet. */
export async function seedDefaultAbTestLanes(
  client: PoolClient,
  groupId: string,
): Promise<void> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ab_test_board_lanes WHERE group_id = $1`,
    [groupId],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return;

  for (let i = 0; i < DEFAULT_AB_TEST_LANES.length; i++) {
    const lane = DEFAULT_AB_TEST_LANES[i]!;
    await client.query(
      `INSERT INTO ab_test_board_lanes (group_id, name, "order", is_terminal)
       VALUES ($1, $2, $3, $4)`,
      [groupId, lane.name, i, lane.is_terminal],
    );
  }
}
