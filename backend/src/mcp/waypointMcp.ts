import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "../db/pool.js";
import type { Role } from "../types.js";

/**
 * Build a fresh MCP server instance for one Streamable HTTP request
 * (stateless). Tools read from the caller's authenticated tenant —
 * `ctx.groupId` / `ctx.userId` / `ctx.role` come from Express
 * authenticate + groupScope.
 */

export type McpAuthContext = {
  userId: string;
  userName: string;
  userEmail: string;
  groupId: string;
  role: Role;
  isAdmin: boolean;
};

const PROJECT_COLUMNS = `
  p.id, p.title, p.description, p.type, p.parent_id,
  p.owner_id, p.swim_lane_id, p.global_priority,
  p.is_key_strategic, p.is_blocked, p.blocked_reason,
  p.hidden_from_roadmap, p.dates_locked,
  to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(p.target_date, 'YYYY-MM-DD') AS target_date,
  to_char(p.dev_start_date, 'YYYY-MM-DD') AS dev_start_date,
  to_char(p.dev_end_date, 'YYYY-MM-DD') AS dev_end_date,
  to_char(p.optimization_start_date, 'YYYY-MM-DD') AS optimization_start_date,
  to_char(p.optimization_end_date, 'YYYY-MM-DD') AS optimization_end_date,
  COALESCE(
    (SELECT array_agg(pt.team_id ORDER BY pt.position ASC)
       FROM project_teams pt WHERE pt.project_id = p.id),
    ARRAY[]::UUID[]
  ) AS teams,
  COALESCE(
    (SELECT jsonb_agg(
              jsonb_build_object(
                'kpi_id', pk.kpi_id,
                'impact_swag', pk.impact_swag
              )
              ORDER BY pk.position ASC
            )
       FROM project_kpis pk WHERE pk.project_id = p.id),
    '[]'::jsonb
  ) AS kpis
`;

const HIDDEN_LANE_CLAUSE = `
  NOT EXISTS (
    SELECT 1 FROM swim_lanes sl
    WHERE sl.id = p.swim_lane_id AND sl.is_admin_only = TRUE
  )
`;

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function createWaypointMcpServer(ctx: McpAuthContext): McpServer {
  const server = new McpServer({
    name: "waypoint",
    version: "1.0.0",
  });

  server.registerTool(
    "whoami",
    {
      description:
        "Return the authenticated Waypoint user, active workspace (group), and role for this API token.",
    },
    async () => {
      const { rows: groups } = await query<{ id: string; name: string }>(
        `SELECT id, name FROM groups WHERE id = $1`,
        [ctx.groupId],
      );
      return textResult({
        user: {
          id: ctx.userId,
          name: ctx.userName,
          email: ctx.userEmail,
          role: ctx.role,
        },
        group: groups[0] ?? { id: ctx.groupId, name: null },
      });
    },
  );

  server.registerTool(
    "list_teams",
    {
      description: "List teams in the active Waypoint workspace.",
    },
    async () => {
      const { rows } = await query(
        `SELECT id, name, color, capacity, description, "order"
           FROM teams
          WHERE group_id = $1
          ORDER BY "order" ASC NULLS LAST, name ASC`,
        [ctx.groupId],
      );
      return textResult(rows);
    },
  );

  server.registerTool(
    "list_kpis",
    {
      description: "List KPIs in the active Waypoint workspace (id, name, color, description).",
    },
    async () => {
      const { rows } = await query(
        `SELECT id, name, color, description, "order"
           FROM kpis
          WHERE group_id = $1
          ORDER BY "order" ASC, name ASC`,
        [ctx.groupId],
      );
      return textResult(rows);
    },
  );

  server.registerTool(
    "list_swim_lanes",
    {
      description: "List swim lanes (board columns) in the active workspace.",
    },
    async () => {
      const clauses = ["group_id = $1"];
      if (!ctx.isAdmin) clauses.push("is_admin_only = FALSE");
      const { rows } = await query(
        `SELECT id, name, color, "order", is_admin_only, phase_date_key, is_terminal
           FROM swim_lanes
          WHERE ${clauses.join(" AND ")}
          ORDER BY "order" ASC`,
        [ctx.groupId],
      );
      return textResult(rows);
    },
  );

  server.registerTool(
    "list_projects",
    {
      description:
        "List backlog/roadmap projects in the active workspace. Use filters to narrow; results are capped.",
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Case-insensitive substring match on title or description"),
        team_id: z.string().uuid().optional().describe("Only projects on this team"),
        kpi_id: z.string().uuid().optional().describe("Only projects assigned this KPI"),
        scheduled_only: z
          .boolean()
          .optional()
          .describe("If true, only projects with a start_date and target_date"),
        include_hidden_from_roadmap: z
          .boolean()
          .optional()
          .describe("Include projects marked hidden_from_roadmap (default false)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max rows (default 50, max 200)"),
      },
    },
    async (args) => {
      const limit = args.limit ?? 50;
      const clauses = ["p.group_id = $1", "p.deleted_at IS NULL"];
      const params: unknown[] = [ctx.groupId];
      if (!ctx.isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
      if (!args.include_hidden_from_roadmap) {
        clauses.push("p.hidden_from_roadmap = FALSE");
      }
      if (args.query?.trim()) {
        params.push(`%${args.query.trim()}%`);
        clauses.push(
          `(p.title ILIKE $${params.length} OR COALESCE(p.description, '') ILIKE $${params.length})`,
        );
      }
      if (args.team_id) {
        params.push(args.team_id);
        clauses.push(
          `EXISTS (SELECT 1 FROM project_teams pt WHERE pt.project_id = p.id AND pt.team_id = $${params.length})`,
        );
      }
      if (args.kpi_id) {
        params.push(args.kpi_id);
        clauses.push(
          `EXISTS (SELECT 1 FROM project_kpis pk WHERE pk.project_id = p.id AND pk.kpi_id = $${params.length})`,
        );
      }
      if (args.scheduled_only) {
        clauses.push("p.start_date IS NOT NULL AND p.target_date IS NOT NULL");
      }
      params.push(limit);
      const { rows } = await query(
        `SELECT ${PROJECT_COLUMNS}
           FROM projects p
          WHERE ${clauses.join(" AND ")}
          ORDER BY p.global_priority ASC NULLS LAST, p.position ASC, p.created_at ASC
          LIMIT $${params.length}`,
        params,
      );
      return textResult({ count: rows.length, projects: rows });
    },
  );

  server.registerTool(
    "get_project",
    {
      description: "Fetch one project by id, including KPI assignments with impact SWAG.",
      inputSchema: {
        project_id: z.string().uuid().describe("Project UUID"),
      },
    },
    async ({ project_id }) => {
      const clauses = ["p.id = $1", "p.group_id = $2", "p.deleted_at IS NULL"];
      if (!ctx.isAdmin) clauses.push(HIDDEN_LANE_CLAUSE);
      const { rows } = await query(
        `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE ${clauses.join(" AND ")}`,
        [project_id, ctx.groupId],
      );
      if (!rows[0]) {
        return {
          content: [{ type: "text" as const, text: "Project not found in this workspace." }],
          isError: true,
        };
      }
      return textResult(rows[0]);
    },
  );

  server.registerTool(
    "search_projects",
    {
      description:
        "Full-text-ish search across project titles and descriptions. Prefer this for open-ended questions.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Search string"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query: q, limit }) => {
      const params: unknown[] = [ctx.groupId, `%${q.trim()}%`, limit ?? 25];
      const adminClause = ctx.isAdmin ? "" : `AND ${HIDDEN_LANE_CLAUSE}`;
      const { rows } = await query(
        `SELECT ${PROJECT_COLUMNS}
           FROM projects p
          WHERE p.group_id = $1
            AND p.deleted_at IS NULL
            AND p.hidden_from_roadmap = FALSE
            ${adminClause}
            AND (p.title ILIKE $2 OR COALESCE(p.description, '') ILIKE $2)
          ORDER BY p.global_priority ASC NULLS LAST, p.title ASC
          LIMIT $3`,
        params,
      );
      return textResult({ count: rows.length, projects: rows });
    },
  );

  return server;
}
