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
  {
    name: "Archive",
    color: "#475569",
    is_admin_only: true,
    is_archive: true,
    description:
      "Cards parked here are hidden from non-admin views. Move a card out of Archive (via the lane menu) to bring it back onto the board.",
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

// Outcome-level KPIs that projects contribute to. Kept short so the
// KPI report tab has representative buckets out of the box.
const KPIS = [
  { name: "Revenue",             color: "#22c55e", description: "Direct topline lift from redemptions, subscriptions, and paid partnerships." },
  { name: "SEO Traffic",         color: "#0ea5e9", description: "Organic sessions and impressions from search-driven surfaces." },
  { name: "Customer Retention",  color: "#a855f7", description: "Repeat visits and long-term account engagement — including loyalty-tier progression." },
  { name: "Mobile Engagement",   color: "#f97316", description: "iOS + Android DAU, session length, and push open rate." },
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
    // Include groups + user_groups in the wipe so a re-seed reliably
    // starts from a blank multi-tenant world; CASCADE from users
    // covers user_groups but we truncate explicitly to be obvious.
    await client.query(
      "TRUNCATE weekly_status_updates, status_history, project_audit_events, project_comments, project_teams, project_kpis, projects, teams, kpis, tshirt_sizes, swim_lanes, user_groups, groups, users RESTART IDENTITY CASCADE",
    );

    console.log("Seeding groups...");
    // Two tenants match what migration 017 provisions on an already-
    // populated DB; the seeder is what a fresh install runs, so we
    // set them up here too.
    const { rows: rmnRows } = await client.query<{ id: string }>(
      `INSERT INTO groups (name, color) VALUES ('RetailMeNot', '#DC2626') RETURNING id`,
    );
    const rmnGroupId = rmnRows[0]!.id;
    const { rows: vcRows } = await client.query<{ id: string }>(
      `INSERT INTO groups (name, color) VALUES ('VoucherCodes', '#0EA5E9') RETURNING id`,
    );
    const vcGroupId = vcRows[0]!.id;

    console.log("Seeding users...");
    const userIds: Record<string, string> = {};
    for (const u of USERS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, role, color, current_group_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [u.email, u.name, u.role, u.color, rmnGroupId],
      );
      userIds[u.email] = rows[0]!.id;
    }
    const adminId = userIds["roland@waypoint.example"]!;
    const owner1Id = userIds["roland@waypoint.example"]!;
    const owner2Id = userIds["mag@waypoint.example"]!;

    console.log("Enrolling users in RetailMeNot...");
    for (const u of USERS) {
      await client.query(
        `INSERT INTO user_groups (user_id, group_id, role) VALUES ($1, $2, $3)`,
        [userIds[u.email], rmnGroupId, u.role],
      );
    }
    // Roland + Mag also get admin access to VoucherCodes so the group
    // switcher has something to switch TO out of the box.
    for (const email of ["roland@waypoint.example", "mag@waypoint.example"]) {
      await client.query(
        `INSERT INTO user_groups (user_id, group_id, role) VALUES ($1, $2, 'admin')`,
        [userIds[email], vcGroupId],
      );
    }

    console.log("Seeding RetailMeNot swim lanes...");
    const laneIds: Record<string, string> = {};
    for (let i = 0; i < DEFAULT_LANES.length; i++) {
      const l = DEFAULT_LANES[i]!;
      const isDefaultNew = l.name === "Backlog";
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO swim_lanes
           (group_id, name, description, "order", color, is_terminal, requires_weekly_status,
            is_default_new, is_admin_only, is_archive, phase_date_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          rmnGroupId,
          l.name, l.description ?? "", i, l.color,
          l.is_terminal ?? false, l.requires_weekly_status ?? false,
          isDefaultNew,
          (l as { is_admin_only?: boolean }).is_admin_only ?? false,
          (l as { is_archive?: boolean }).is_archive ?? false,
          (l as { phase_date_key?: string }).phase_date_key ?? null,
          adminId,
        ],
      );
      laneIds[l.name] = rows[0]!.id;
    }

    console.log("Seeding VoucherCodes swim lanes (minimal defaults)...");
    // Give VC a slim workflow of its own so the group is usable the
    // moment an admin switches to it. Deliberately shorter than RMN's
    // so it's clearly a different tenant, not a mirror.
    const vcLanes = [
      { name: "Backlog",       color: "#94A3B8", is_default_new: true,  phase_date_key: null as string | null },
      { name: "Ready for Dev", color: "#3B82F6", is_default_new: false, phase_date_key: "target_date" },
      { name: "In Dev",        color: "#F59E0B", is_default_new: false, phase_date_key: "dev_start_date", requires_weekly_status: true },
      { name: "Complete",      color: "#10B981", is_default_new: false, phase_date_key: "optimization_end_date", is_terminal: true },
      { name: "Archive",       color: "#64748B", is_default_new: false, phase_date_key: null, is_admin_only: true, is_archive: true, is_terminal: true },
    ];
    for (let i = 0; i < vcLanes.length; i++) {
      const l = vcLanes[i]!;
      await client.query(
        `INSERT INTO swim_lanes
           (group_id, name, description, "order", color, is_terminal, requires_weekly_status,
            is_default_new, is_admin_only, is_archive, phase_date_key, created_by)
         VALUES ($1, $2, '', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          vcGroupId,
          l.name, i, l.color,
          (l as { is_terminal?: boolean }).is_terminal ?? false,
          (l as { requires_weekly_status?: boolean }).requires_weekly_status ?? false,
          l.is_default_new,
          (l as { is_admin_only?: boolean }).is_admin_only ?? false,
          (l as { is_archive?: boolean }).is_archive ?? false,
          l.phase_date_key,
          adminId,
        ],
      );
    }

    console.log("Seeding RetailMeNot teams...");
    const teamIds: Record<string, string> = {};
    for (let i = 0; i < TEAMS.length; i++) {
      const t = TEAMS[i]!;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO teams (group_id, name, color, "order", created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [rmnGroupId, t.name, t.color, i, adminId],
      );
      teamIds[t.name] = rows[0]!.id;
    }

    console.log("Seeding RetailMeNot KPIs...");
    const kpiIds: Record<string, string> = {};
    for (let i = 0; i < KPIS.length; i++) {
      const k = KPIS[i]!;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO kpis (group_id, name, description, color, "order", created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [rmnGroupId, k.name, k.description, k.color, i, adminId],
      );
      kpiIds[k.name] = rows[0]!.id;
    }

    console.log("Seeding T-shirt size presets for both groups...");
    // Both tenants get the standard S/M/L/XL/XXL ladder that backs the
    // EZEstimates view's size picker. Mirrors migration 028 + the
    // group-create hook in routes/groups.ts so a fresh seed lands
    // identical to those paths.
    const TSHIRT_SEEDS: Array<{ label: string; days: number; position: number }> = [
      { label: "S",   days: 3,  position: 0 },
      { label: "M",   days: 7,  position: 1 },
      { label: "L",   days: 14, position: 2 },
      { label: "XL",  days: 30, position: 3 },
      { label: "XXL", days: 90, position: 4 },
    ];
    for (const groupId of [rmnGroupId, vcGroupId]) {
      for (const s of TSHIRT_SEEDS) {
        await client.query(
          `INSERT INTO tshirt_sizes (group_id, label, days, position)
           VALUES ($1, $2, $3, $4)`,
          [groupId, s.label, s.days, s.position],
        );
      }
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
      /** Ordered list of KPI names this project contributes to. */
      kpis?: string[];
      /** Which other seed project (by title) this one nests under. When
       * omitted or undefined the row is inserted as an epic. */
      parentTitle?: string;
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
        kpis: ["Revenue", "SEO Traffic"],
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
        kpis: ["SEO Traffic"],
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
        kpis: ["Customer Retention", "Revenue"],
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
        kpis: ["Mobile Engagement"],
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
      // Two subtasks under an existing epic so the roadmap tree has
      // something interesting to expand out of the box, and one nested
      // subtask so the "arbitrary depth" bit is exercised too.
      {
        title: "Coupon detail — merchant sidebar refactor",
        description: "Subtask: extract the merchant summary into a reusable sidebar module.",
        lane: "In Dev",
        owner: owner2Id,
        teams: ["Coupons"],
        tags: ["web"],
        parentTitle: "Coupon detail page redesign",
        start_date: addDays(today, -30),
        target_date: addDays(today, -10),
        dev_end_date: addDays(today, 4),
        optimization_end_date: addDays(today, 15),
      },
      {
        title: "Coupon detail — CTA A/B rollout",
        description: "Subtask: run the CTA copy experiment across three treatments.",
        lane: "Dev Ready",
        owner: owner1Id,
        teams: ["Coupons"],
        tags: ["experiment"],
        parentTitle: "Coupon detail page redesign",
        start_date: addDays(today, -15),
        target_date: addDays(today, 2),
        dev_end_date: addDays(today, 6),
        optimization_end_date: addDays(today, 19),
      },
      {
        title: "Coupon detail — treatment C copy tuning",
        description: "Nested subtask under the CTA A/B rollout.",
        lane: "Backlog",
        owner: owner1Id,
        teams: ["Coupons"],
        tags: [],
        parentTitle: "Coupon detail — CTA A/B rollout",
        start_date: addDays(today, -5),
        target_date: addDays(today, 4),
        dev_end_date: addDays(today, 6),
        optimization_end_date: addDays(today, 12),
      },
    ];

    // Insert in dependency order so subtasks always find their parent
    // already in the map. Handles arbitrary-depth chains provided the
    // seed array as a whole is DAG-consistent (each `parentTitle`
    // exists elsewhere in the array).
    const idByTitle: Record<string, string> = {};
    const remaining = projects.map((p, originalIndex) => ({ p, originalIndex }));
    while (remaining.length) {
      const readyIdx = remaining.findIndex(
        ({ p }) => !p.parentTitle || idByTitle[p.parentTitle] !== undefined,
      );
      if (readyIdx === -1) {
        throw new Error("seed hierarchy has an unresolved parentTitle — check for typos or cycles");
      }
      const { p, originalIndex } = remaining.splice(readyIdx, 1)[0]!;
      const laneId = laneIds[p.lane]!;
      const type = p.parentTitle ? "subtask" : "epic";
      const parentId = p.parentTitle ? idByTitle[p.parentTitle]! : null;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO projects
           (group_id, title, description, swim_lane_id, position, owner_id, tags,
            type, parent_id,
            start_date, target_date, dev_start_date, dev_end_date,
            optimization_start_date, optimization_end_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          rmnGroupId,
          p.title, p.description, laneId, originalIndex, p.owner, p.tags,
          type, parentId,
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
      idByTitle[p.title] = pid;

      // Team join rows also carry a per-project position (same
      // shape as project_kpis) so the frontend renders and lets the
      // PM reorder them left-to-right in the order declared here.
      for (let ti = 0; ti < p.teams.length; ti++) {
        const teamId = teamIds[p.teams[ti]!];
        if (!teamId) continue;
        await client.query(
          `INSERT INTO project_teams (project_id, team_id, position) VALUES ($1, $2, $3)`,
          [pid, teamId, ti],
        );
      }

      // KPI join rows carry a per-project position so the frontend
      // renders (and lets the PM reorder) them left-to-right in the
      // order declared here.
      if (p.kpis?.length) {
        for (let ki = 0; ki < p.kpis.length; ki++) {
          const kpiId = kpiIds[p.kpis[ki]!];
          if (!kpiId) continue;
          await client.query(
            `INSERT INTO project_kpis (project_id, kpi_id, position) VALUES ($1, $2, $3)`,
            [pid, kpiId, ki],
          );
        }
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
    // Iterate in declaration order (not insertion order) — the "first
    // eligible" flag below relies on stable per-seed positioning.
    // Look up id via the title map since subtasks may have been
    // inserted before their earlier siblings due to dep ordering.
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i]!;
      const lane = DEFAULT_LANES.find((l) => l.name === p.lane);
      if (!lane?.requires_weekly_status) continue;
      const pid = idByTitle[p.title]!;

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
