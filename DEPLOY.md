# Deployment

Waypoint ships as a single Docker image serving compiled React SPA (`/`) and Express API (`/api/*`) on the same port. Data lives in an external Postgres. Auto-deployed to [Fly.io](https://fly.io) on every green push to `main`.

- [1. Artifacts in this repo](#1-artifacts-in-this-repo)
- [2. First-time Fly.io setup](#2-first-time-flyio-setup)
- [3. Enabling auto-deploy from GitHub](#3-enabling-auto-deploy-from-github)
- [4. Environment variables](#4-environment-variables)
- [5. Locking down auth before real data lands](#5-locking-down-auth-before-real-data-lands)
- [6. Local prod-like run](#6-local-prod-like-run)
- [7. Bootstrapping real users](#7-bootstrapping-real-users)
- [8. Rollbacks + migrations](#8-rollbacks--migrations)
- [9. Redeploying elsewhere](#9-redeploying-elsewhere)

## 1. Artifacts in this repo

| Path | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build → single Node 20 alpine image; runs migrations then boots on start |
| `fly.toml` | Fly.io app config (region, VM size, health check) |
| `.github/workflows/ci.yml` | On PR + push: typecheck both apps, boot the API against a disposable Postgres, run `scripts/smoke.sh` |
| `.github/workflows/deploy.yml` | On push to `main`: `flyctl deploy --remote-only` |
| `scripts/smoke.sh` | End-to-end API smoke test |
| `backend/src/db/importUsers.ts` | Idempotent user bootstrap (`npm run import-users`) |
| `docker-compose.prod.yml` | Local reproduction of the deployed image against the compose Postgres |

## 2. First-time Fly.io setup

One-time bootstrap for a fresh Fly account. **Total time: ~5 min.**

```bash
# 0. Install flyctl if you haven't
brew install flyctl

# 1. Sign in
fly auth signup   # or `fly auth login` if you already have an account

# 2. Launch the app from the existing fly.toml (no deploy yet)
fly launch --no-deploy --copy-config --name waypoint-qmh6xa

# 3. Provision a managed Postgres + attach it to the app.
#    `attach` writes DATABASE_URL into the app's secrets automatically.
fly postgres create --name waypoint-db --region iad --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 3
fly postgres attach waypoint-db --app waypoint-qmh6xa

# 4. Deploy for the first time
fly deploy

# 5. Verify
fly status
fly logs
open https://waypoint-qmh6xa.fly.dev
```

If `waypoint` is taken as a Fly app name, pick something else (e.g. `waypoint-rh`) — update `app = "..."` in `fly.toml` to match, and use that name for the attach + subsequent deploys.

## 3. Enabling auto-deploy from GitHub

The `deploy.yml` workflow runs `flyctl deploy` on every push to `main`. It needs one secret:

```bash
# Generate a scoped deploy token
fly tokens create deploy --app waypoint-qmh6xa --name gha-deploy

# Store it as a repo secret
gh secret set FLY_API_TOKEN -R rolandhollis/Waypoint  # paste the token when prompted
```

That's it — the next push to `main` will build the Dockerfile on Fly's remote builder and roll out a new machine.

The `ci.yml` workflow needs no secrets; it uses a Postgres service container on the runner.

## 4. Environment variables

Everything the app needs at runtime is env-driven. Reference: `backend/.env.example`.

| Env var | Required | Where in prod |
|---------|----------|---------------|
| `DATABASE_URL` | **yes** | Fly secret (auto-set by `fly postgres attach`) |
| `AUTH_MODE` | no (defaults to `mock`) | `[env]` in `fly.toml` |
| `PORT` | no (defaults to `4000`) | `[env]` in `fly.toml` |
| `STATIC_DIR` | pre-set in the image | `Dockerfile` |
| `REPORTING_TIMEZONE` | no (defaults to `America/Chicago`) | `[env]` in `fly.toml` |
| `OKTA_ISSUER`, `OKTA_AUDIENCE`, `OKTA_CLIENT_ID` | if `AUTH_MODE=okta` | `fly secrets set` |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | if `AUTH_MODE=cloudflare-access` | `fly secrets set` |
| `CORS_ORIGIN` | only relevant when SPA runs on a different origin (dev only) | n/a in prod |

To rotate or add a secret:

```bash
fly secrets set CF_ACCESS_AUD=abc123... --app waypoint-qmh6xa
# Fly automatically restarts machines when secrets change.
```

## 5. Locking down auth before real data lands

The default `AUTH_MODE=mock` is unsafe on the public internet — anyone with the URL can pick a user from the mock roster and act as them. The app renders a persistent amber "demo mode" banner at the top while this is active as a reminder.

Two production-ready paths:

### Option A — Cloudflare Access (recommended, free tier fits)

1. Sign into Cloudflare, add whatever domain you're pointing at Fly (or use Cloudflare Tunnel to reach `waypoint-qmh6xa.fly.dev`).
2. Zero Trust → Access → Applications → **Add an application** → Self-hosted.
3. Application domain: `waypoint.<yourdomain>`. Session duration: 24h.
4. Add an IdP (Google Workspace / GitHub / Okta — Cloudflare handles the OIDC dance).
5. Add an Access policy that allows the emails you want in.
6. From the app's Overview tab, copy the **Application Audience (AUD) Tag**.
7. Point Fly at it:

    ```bash
    fly secrets set \
      AUTH_MODE=cloudflare-access \
      CF_ACCESS_TEAM_DOMAIN=<your-team>.cloudflareaccess.com \
      CF_ACCESS_AUD=<aud-from-step-6> \
      --app waypoint-qmh6xa
    ```

8. Update `fly.toml`'s `[env]` block: change `AUTH_MODE = "mock"` → `AUTH_MODE = "cloudflare-access"` so redeploys keep it. (Secrets override `[env]`, but changing both keeps `fly.toml` accurate.)

Now every request hits CF Access first, which forwards a signed JWT. The app verifies it against the CF Access JWKS and matches the `email` claim to a provisioned user (see [§7](#7-bootstrapping-real-users)).

### Option B — Direct Okta OIDC

If you already have an Okta tenant and don't want the CF Access hop:

```bash
fly secrets set \
  AUTH_MODE=okta \
  OKTA_ISSUER=https://<your-org>.okta.com \
  OKTA_AUDIENCE=<audience> \
  OKTA_CLIENT_ID=<client-id> \
  --app waypoint-qmh6xa
```

The SPA is currently mock-only for the login flow — wiring the browser-side Okta redirect is left as an exercise. The backend JWT verification is done.

## 6. Local prod-like run

Reproduces the deployed environment on your machine — same image, same migration path, same static-serving.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
# then open http://localhost:8080
```

Or build the exact image `fly deploy` would ship:

```bash
docker build -t waypoint .
docker run --rm -p 8080:4000 \
  -e DATABASE_URL="postgres://waypoint:waypoint@host.docker.internal:5433/waypoint" \
  -e AUTH_MODE=mock \
  waypoint
```

## 7. Bootstrapping real users

Once auth is locked down ([§5](#5-locking-down-auth-before-real-data-lands)), the `email` claim from the IdP has to match a row in the `users` table.

```bash
cat > /tmp/users.json <<'JSON'
[
  { "email": "you@example.com",       "name": "Roland",   "role": "admin" },
  { "email": "teammate@example.com",  "name": "Teammate", "role": "owner" }
]
JSON

# Ship the file into the container and run the importer
fly ssh sftp shell --app waypoint-qmh6xa <<'SFTP'
put /tmp/users.json /tmp/users.json
SFTP

fly ssh console --app waypoint-qmh6xa --command "node backend/dist/db/importUsers.js /tmp/users.json --dry-run"
fly ssh console --app waypoint-qmh6xa --command "node backend/dist/db/importUsers.js /tmp/users.json"
```

Or run it from your laptop against the Fly Postgres directly:

```bash
# Proxy the Fly Postgres to localhost:15432
fly proxy 15432:5432 --app waypoint-db &
export DATABASE_URL="postgres://<user>:<pass>@localhost:15432/waypoint"  # see `fly secrets list` for creds
cd backend && npm ci && npm run import-users -- /tmp/users.json
```

Roles:
- **admin** — everything, including swim-lane/product-area/user management
- **owner** — create/edit projects and submit status updates
- **viewer** — read-only

## 8. Rollbacks + migrations

- **App rollback**: `fly releases --app waypoint-qmh6xa` shows the release history. `fly releases rollback <version>` reverts to that image.
- **Schema changes**: migrations live in `backend/src/db/migrations/NNN_*.sql` and are applied in filename order at container startup. Idempotent via a `_migrations` ledger table.
- **Never edit an applied migration file** — write a new one that walks the schema forward. Prefer additive migrations (nullable columns, new tables) so the previous image keeps working during a rolling deploy.

## 9. Redeploying elsewhere

Nothing about this app is Fly-specific except `fly.toml`. The same Dockerfile runs on:

- **Railway / Render** — point at the repo, they detect the Dockerfile, inject `DATABASE_URL` from their managed Postgres, expose `PORT`.
- **GHCR + a VPS** — add a workflow that builds and pushes to `ghcr.io/rolandhollis/waypoint`, then `docker run` it wherever you like.
- **Kubernetes** — standard `Deployment` + `Service` + `Ingress`; `DATABASE_URL` from a secret. The image self-migrates on boot so no init container needed.

## Health + smoke check

- `GET /api/health` → `{"ok":true,"auth":"<mode>"}`. Wired into Fly's `[[http_service.checks]]` block.
- `scripts/smoke.sh` exercises the full request lifecycle (create / patch / move / delete a project) against any URL:

  ```bash
  API_URL=https://waypoint-qmh6xa.fly.dev ./scripts/smoke.sh
  ```

  In `mock` mode it uses the mock roster automatically. Behind CF Access you'll need to fork the script to attach a service-token header (or run it from inside a CF Access session).
