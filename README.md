# Waypoint

Product management tool for tracking ideas from initial capture through a defined development process, with three primary views:

1. **Board** — Trello-style Kanban with configurable swim lanes and drag-and-drop.
2. **Roadmap** — segmented Gantt showing each project's three-phase timeline (Discovery/Definition → Development → Post-Dev Optimization) with drag-to-reschedule.
3. **Status Report** — weekly portfolio health view sorted Red → Yellow → Green → White.

> **Demo mode.** The default `AUTH_MODE=mock` lets anyone with the URL sign in as any user. Fine for kicking the tires — do not put real data behind it without wiring up real auth first (`cloudflare-access` and `okta` code paths already exist; see [DEPLOY.md](DEPLOY.md)).

## Stack

- **Frontend:** React 18 + Vite + TypeScript, Tailwind CSS + shadcn/ui, `@dnd-kit/core`, TanStack Query, React Router.
- **Backend:** Node.js + Express + TypeScript, `pg`, `zod`, `node-cron`, `date-fns-tz` (timezone-correct weekly cadence).
- **Database:** PostgreSQL 16 (Docker Compose locally, Fly Postgres in prod).
- **Deploy:** Single Docker image serves compiled SPA + API. GitHub Actions runs typecheck + smoke on every PR and auto-deploys `main` to [Fly.io](https://fly.io) — full runbook in [DEPLOY.md](DEPLOY.md).

## Local setup

Prerequisites: Node 20+, npm, Docker Desktop.

```bash
# 1. Start Postgres
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev    # http://localhost:4000

# 3. Frontend (in a second terminal)
cd frontend
cp .env.example .env
npm install
npm run dev    # http://localhost:5173
```

Open `http://localhost:5173` and pick a mock user from the login screen.

## Repository layout

```
backend/                 Express API, migrations, cron jobs
frontend/                React SPA
scripts/smoke.sh         End-to-end API smoke test used by CI
.github/workflows/       ci (typecheck + smoke on PR) + deploy (Fly on main)
Dockerfile               single image serving compiled SPA + API
fly.toml                 Fly.io launch config
docker-compose.yml       dev Postgres only
docker-compose.prod.yml  prod-like local overlay
```

## Auth modes

Auth mode is controlled by `AUTH_MODE` in `backend/.env`:

- `mock` (default) — anyone with the URL picks a user from the login screen. Frontend renders a persistent "demo mode" banner while this is active.
- `cloudflare-access` — Cloudflare Access sits in front of the app, does the OIDC dance with the IdP, and forwards a signed JWT on every request. The app verifies the JWT against the CF Access JWKS and matches the `email` claim to a provisioned user.
- `okta` — direct Okta OIDC bearer-token verification.

Full setup + deployment notes: [DEPLOY.md](DEPLOY.md).

## Verify with the smoke test

```bash
./scripts/smoke.sh   # exercises the full API round-trip against localhost:4000
```

CI runs this on every PR against a disposable Postgres.

## Roles

- **Admin** — everything, plus swim lane / product area / user role management.
- **Owner** — create/edit/move projects; submit weekly status updates for their own projects.
- **Viewer** — read-only Board / Roadmap / Status Report; write endpoints return 403.

## Weekly status timing

- **Reporting week** anchored to Monday of the calendar week (`week_of`).
- **Deadline** Thursday 23:59:59 in the configured `REPORTING_TIMEZONE` (`due_at`), computed via `date-fns-tz` so DST transitions are handled correctly.
- **Reminder banner** appears from Thursday morning until either the deadline passes (then overdue styling) or the Owner completes all eligible updates for the week.
- **Eligibility** is history-based: a project is eligible for a week if it sat in a `requires_weekly_status` lane at any point during that week.

## Notes

- All timeline fields (`start_date`, `target_date`, `dev_end_date`, `optimization_end_date`) are required for a project to appear on the Roadmap; otherwise it sits in an "Unscheduled" panel. Development starts on `target_date` (or the optional `dev_start_date` for an "Awaiting Dev" gap), and Post-Dev Optimization starts on `dev_end_date` (or the optional `optimization_start_date` for an "Awaiting Optimization" gap).
- Phase 2 and Phase 3 end dates are **computed at read time**, never stored — so a PM changing an estimate never leaves data out of sync.
- Real-time sync is done via 5 s polling in v1; websockets can be added later.
