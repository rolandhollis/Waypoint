# Multi-stage build for Waypoint.
#
# Produces a single Node 20 alpine image that serves both the compiled
# Express API (`/api/*`) and the Vite SPA (everything else) on the same
# port, and runs pending migrations on boot so the deploy target doesn't
# need an init container.
#
# Local build:  docker build -t waypoint .
# Fly.io:       `fly deploy` picks this up automatically.

# ---------- Stage 1: install + build frontend ----------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# API_BASE defaults to "/api" in the client — perfect for same-origin serving.
RUN npm run build

# ---------- Stage 2: install + build backend ----------
FROM node:20-alpine AS backend
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ---------- Stage 3: slim runtime with prod deps only ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prod-only backend deps.
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force

# Compiled backend JS + migrations (co-located next to migrate.js so the
# runtime resolver based on import.meta.url finds them).
COPY --from=backend  /app/backend/dist                ./backend/dist
COPY --from=backend  /app/backend/src/db/migrations   ./backend/dist/db/migrations

# Compiled SPA assets served by Express.
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Non-root runtime user.
RUN addgroup -S app && adduser -S -G app app \
 && chown -R app:app /app
USER app

ENV STATIC_DIR=/app/frontend/dist
ENV PORT=4000
EXPOSE 4000

# Migrate then boot. `migrate.js` is idempotent (uses a `_migrations`
# ledger table) so re-running on every start is safe.
CMD ["sh", "-c", "node backend/dist/db/migrate.js && exec node backend/dist/index.js"]

# ---------- OCI metadata (Fly / GHCR set these via --build-arg in CI) ----------
ARG VERSION=dev
ARG REVISION=dev
ARG SOURCE=https://github.com/rolandhollis/Waypoint

LABEL org.opencontainers.image.title="Waypoint" \
      org.opencontainers.image.description="Product backlog & roadmap management tool" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.source="$SOURCE"
