import { pool, withTransaction } from "./pool.js";
import { addDays } from "date-fns";
import { weekOfMonday, dueAtForWeek } from "../lib/time.js";

/**
 * Seed data:
 *  - Mock users (one per role, plus a couple extra Owners).
 *  - Default swim lanes (PRD Appendix).
 *  - Placeholder Product Areas (PRD §9 Q4).
 *  - A handful of demo projects, some with full timeline data and some
 *    intentionally missing fields so the "Unscheduled" panel has content.
 *  - Status history + one week of status updates so the Status Report /
 *    reminder banner have something to render on first boot.
 */

// Descriptions render both on the /phases reference page and in the
// board-column header tooltip; keep them prose-y and focused on the
// "when does something belong in this lane / what happens here" question
// rather than restating the name.
const DEFAULT_LANES = [
  {
    name: "Parking Lot",
    color: "#94a3b8",
    description:
      "Ideas we're not committing to yet. Anything here has been captured deliberately but is not queued for work; revisit during quarterly planning to promote, defer, or archive.",
  },
  {
    name: "Backlog",
    color: "#64748b",
    description:
      "Committed but not yet started. The team agrees these should happen; they're waiting for capacity or upstream dependencies to clear.",
  },
  {
    name: "Discovery",
    color: "#0ea5e9",
    description:
      "Actively researching the problem: user interviews, data exploration, competitive analysis. Exit criteria: a clear problem statement and enough evidence to justify solving it.",
  },
  {
    name: "Definition",
    color: "#6366f1",
    description:
      "Turning the discovered problem into a concrete solution shape: PRD, success metrics, and rough scope. Exit criteria: aligned stakeholders and a green light to design.",
  },
  {
    name: "Design",
    color: "#a855f7",
    description:
      "Design is producing wireframes, mocks, and prototypes. Engineering starts weighing in on feasibility. Exit criteria: design review complete and mocks are dev-ready.",
  },
  {
    name: "Scoping",
    color: "#ec4899",
    description:
      "Engineering is breaking work down, estimating effort, and identifying risks. Exit criteria: agreed timeline, team assignment, and any spike work resolved.",
  },
  {
    name: "Dev Ready",
    color: "#f59e0b",
    requires_weekly_status: true,
    phase_date_key: "target_date" as const,
    description:
      "Fully scoped and waiting for a dev to pick it up. Weekly status is required so we can see anything stalled here longer than expected.",
  },
  {
    name: "In Dev",
    color: "#22c55e",
    requires_weekly_status: true,
    phase_date_key: "dev_start_date" as const,
    description:
      "Active engineering work: coding, review, QA. Weekly status keeps leadership visibility on ship-date confidence and blockers.",
  },
  {
    name: "Complete",
    color: "#0f766e",
    is_terminal: true,
    phase_date_key: "optimization_end_date" as const,
    description:
      "Shipped to production and post-launch monitoring is underway. Moving a card here auto-stamps its actual completion date and stops weekly status prompts.",
  },
];

// Cross-functional pods that "own" a chunk of work. Projects can belong
// to more than one — e.g. a Loyalty initiative built by the Martech pod
// gets both. Renamed from "product areas" in migration 006.
const TEAMS = [
  { name: "Coupons", color: "#ef4444" },
  { name: "SEO", color: "#3b82f6" },
  { name: "Mobile App", color: "#10b981" },
  { name: "Loyalty", color: "#f59e0b" },
  { name: "Martech", color: "#8b5cf6" },
];

// Roland and Mag are admins; everyone else is an owner (can create/edit
// projects and submit status updates for their own). Colors chosen to be
// distinct across the roadmap when "color by owner" is active.
const USERS = [
  { email: "roland@waypoint.example",   name: "Roland",   role: "admin", color: "#E01F2D" },
  { email: "mag@waypoint.example",      name: "Mag",      role: "admin", color: "#7c3aed" },
  { email: "cilla@waypoint.example",    name: "Cilla",    role: "owner", color: "#0891b2" },
  { email: "lauren@waypoint.example",   name: "Lauren",   role: "owner", color: "#16a34a" },
  { email: "andrea@waypoint.example",   name: "Andrea",   role: "owner", color: "#f59e0b" },
  { email: "berett@waypoint.example",   name: "Berett",   role: "owner", color: "#0ea5e9" },
  { email: "dom@waypoint.example",      name: "Dom",      role: "owner", color: "#ec4899" },
  { email: "daniella@waypoint.example", name: "Daniella", role: "owner", color: "#14b8a6" },
  { email: "doug@waypoint.example",     name: "Doug",     role: "owner",  color: "#a855f7" },
  { email: "kim@waypoint.example",      name: "Kim",      role: "viewer", color: "#64748b" },
  { email: "john@waypoint.example",     name: "John",     role: "viewer", color: "#475569" },
];

async function main() {
  await withTransaction(async (client) => {
    console.log("Clearing existing data...");
    await client.query("TRUNCATE weekly_status_updates, status_history, project_audit_events, project_comments, project_teams, projects, teams, swim_lanes, users RESTART IDENTITY CASCADE");

    console.log("Seeding users...");
    const userIds: Record<string, string> = {};
    for (const u of USERS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, role, color) VALUES ($1, $2, $3, $4) RETURNING id`,
        [u.email, u.name, u.role, u.color],
      );
      userIds[u.email] = rows[0]!.id;
    }
    const adminId = userIds["roland@waypoint.example"]!;
    const owner1Id = userIds["roland@waypoint.example"]!;
    const owner2Id = userIds["mag@waypoint.example"]!;

    console.log("Seeding swim lanes...");
    const laneIds: Record<string, string> = {};
    for (let i = 0; i < DEFAULT_LANES.length; i++) {
      const l = DEFAULT_LANES[i]!;
      // Mark "Backlog" as the initial "new item" landing lane; new
      // installs get a sensible target for the board's Add-new CTA
      // without an admin having to visit settings. Admins can move it.
      const isDefaultNew = l.name === "Backlog";
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO swim_lanes
           (name, description, "order", color, is_terminal, requires_weekly_status,
            is_default_new, phase_date_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          l.name, l.description ?? "", i, l.color,
          l.is_terminal ?? false, l.requires_weekly_status ?? false,
          isDefaultNew, (l as { phase_date_key?: string }).phase_date_key ?? null, adminId,
        ],
      );
      laneIds[l.name] = rows[0]!.id;
    }

    console.log("Seeding teams...");
    const teamIds: Record<string, string> = {};
    for (let i = 0; i < TEAMS.length; i++) {
      const t = TEAMS[i]!;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO teams (name, color, "order", created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [t.name, t.color, i, adminId],
      );
      teamIds[t.name] = rows[0]!.id;
    }

    console.log("Seeding projects...");
    const today = new Date();
    type SeedProject = {
      title: string;
      description: string;
      lane: string;
      owner: string;
      teams: string[];
      tags: string[];
      start_date?: Date;
      target_date?: Date;
      dev_start_date?: Date;
      dev_end_date?: Date;
      optimization_start_date?: Date;
      optimization_end_date?: Date;
    };
    const projects: SeedProject[] = [
      {
        title: "Coupon detail page redesign",
        description: "Modernize the coupon detail page with clearer merchant hierarchy and improved CTA placement.",
        lane: "In Dev",
        owner: owner1Id,
        teams: ["Coupons"],
        tags: ["revenue", "web"],
        start_date: addDays(today, -35),
        target_date: addDays(today, -7),
        dev_end_date: addDays(today, 7),
        optimization_end_date: addDays(today, 21),
      },
      {
        title: "SEO title tag experimentation",
        description: "Automated A/B for title tag templates across top merchant pages.",
        lane: "Dev Ready",
        owner: owner2Id,
        teams: ["SEO"],
        tags: ["experiment"],
        start_date: addDays(today, -21),
        target_date: addDays(today, 3),
        dev_end_date: addDays(today, 10),
        optimization_end_date: addDays(today, 31),
      },
      {
        title: "Loyalty tier visibility on receipts",
        description: "Show a customer's current tier and points-to-next-tier on receipt emails. Owned by Loyalty as the initiative, built by Martech as the delivery team.",
        lane: "Design",
        owner: owner1Id,
        teams: ["Loyalty", "Martech"],
        tags: ["email", "retention"],
        start_date: addDays(today, -10),
        target_date: addDays(today, 20),
        dev_end_date: addDays(today, 41),
        optimization_end_date: addDays(today, 55),
      },
      {
        title: "Mobile app cold start optimization",
        description: "Reduce iOS/Android cold start to under 1.5s p95.",
        lane: "Discovery",
        owner: owner2Id,
        teams: ["Mobile App"],
        tags: ["performance"],
      },
      {
        title: "Parking lot: creator marketplace",
        description: "Idea placeholder — future consideration only.",
        lane: "Parking Lot",
        owner: owner1Id,
        teams: ["Loyalty"],
        tags: ["idea"],
      },
      {
        title: "Merchant page schema.org overhaul",
        description: "Rewrite structured data on merchant pages to unlock rich snippets. Dev intentionally deferred one week after ready-for-dev to coordinate with the SEO agency review.",
        lane: "Scoping",
        owner: owner2Id,
        teams: ["SEO"],
        tags: ["seo"],
        start_date: addDays(today, -5),
        target_date: addDays(today, 25),
        dev_start_date: addDays(today, 32),
        dev_end_date: addDays(today, 60),
        optimization_end_date: addDays(today, 74),
      },
    ];

    const projectIds: string[] = [];
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i]!;
      const laneId = laneIds[p.lane]!;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO projects
           (title, description, swim_lane_id, position, owner_id, tags,
            start_date, target_date, dev_start_date, dev_end_date,
            optimization_start_date, optimization_end_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [
          p.title, p.description, laneId, i, p.owner, p.tags,
          p.start_date ?? null,
          p.target_date ?? null,
          p.dev_start_date ?? null,
          p.dev_end_date ?? null,
          p.optimization_start_date ?? null,
          p.optimization_end_date ?? null,
          adminId,
        ],
      );
      const pid = rows[0]!.id;
      projectIds.push(pid);

      for (const teamName of p.teams) {
        const teamId = teamIds[teamName];
        if (!teamId) continue;
        await client.query(
          `INSERT INTO project_teams (project_id, team_id) VALUES ($1, $2)`,
          [pid, teamId],
        );
      }

      await client.query(
        `INSERT INTO status_history (project_id, from_swim_lane_id, to_swim_lane_id, moved_by_user_id)
         VALUES ($1, NULL, $2, $3)`,
        [pid, laneId, adminId],
      );
    }

    console.log("Seeding this week's status updates...");
    const weekOf = weekOfMonday(today);
    const dueAt = dueAtForWeek(weekOf);
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i]!;
      const lane = DEFAULT_LANES.find((l) => l.name === p.lane);
      if (!lane?.requires_weekly_status) continue;
      const pid = projectIds[i]!;

      const isFirstEligible = i === 0;
      await client.query(
        `INSERT INTO weekly_status_updates
           (project_id, submitted_by_user_id, original_submitted_by_user_id, week_of, health_flag,
            executive_summary, detailed_update, completed, due_at, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
        [
          pid,
          isFirstEligible ? p.owner : null,
          isFirstEligible ? p.owner : null,
          weekOf.toISOString().slice(0, 10),
          isFirstEligible ? "green" : "white",
          isFirstEligible ? "On track for end-of-week merge; QA in progress." : "",
          JSON.stringify(
            isFirstEligible
              ? [
                  "Backend endpoints landed.",
                  "Frontend integration in review.",
                  "QA test plan approved.",
                ]
              : [],
          ),
          isFirstEligible,
          dueAt.toISOString(),
          isFirstEligible ? new Date().toISOString() : null,
        ],
      );
    }

    console.log("Seed complete.");
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
