import "express-async-errors";
import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { authenticate, groupScope } from "./middleware/auth.js";
import { csrfGuard } from "./middleware/csrf.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { bootstrapSuperAdmin } from "./auth/bootstrap.js";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { groupsRouter } from "./routes/groups.js";
import { swimLanesRouter } from "./routes/swimLanes.js";
import { teamsRouter } from "./routes/teams.js";
import { kpisRouter } from "./routes/kpis.js";
import { importsRouter } from "./routes/imports.js";
import { projectsRouter } from "./routes/projects.js";
import { projectCommentsRouter } from "./routes/comments.js";
import { projectDeadlinesRouter } from "./routes/deadlines.js";
import { projectDependenciesRouter } from "./routes/dependencies.js";
import { projectStatusUpdatesRouter, statusUpdatesRouter } from "./routes/statusUpdates.js";
import { startCron } from "./jobs/weeklyStatus.js";

const app = express();

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// CSRF defense (no-op in mock/okta modes; see middleware/csrf.ts).
app.use(csrfGuard);

app.get("/api/health", (_req, res) => res.json({ ok: true, auth: config.authMode }));

// Auth endpoints (login/logout) are intentionally NOT behind
// authenticate — they run before a session exists.
app.use("/api/auth", authRouter);

// Unauthenticated: mock roster for the dev switcher. In mock mode only.
app.use("/api/users", (req, res, next) => {
  if (req.method === "GET" && req.path === "/mock-roster" && config.authMode === "mock") {
    return next();
  }
  return authenticate(req, res, next);
}, usersRouter);

// Groups router only needs authenticate — it manages tenants, so
// it explicitly must NOT be scoped to the caller's current group.
app.use("/api/groups", authenticate, groupsRouter);

// Every product-facing router below is scoped to the caller's
// current group by the groupScope middleware. Endpoints inside
// these routers read req.groupId (never req.user.current_group_id
// directly) so any future changes to how "current group" is
// resolved live in exactly one place.
app.use("/api/swim-lanes", authenticate, groupScope, swimLanesRouter);
app.use("/api/teams", authenticate, groupScope, teamsRouter);
app.use("/api/kpis", authenticate, groupScope, kpisRouter);
app.use("/api/imports", authenticate, groupScope, importsRouter);
app.use("/api/projects", authenticate, groupScope, projectsRouter);
app.use("/api/projects/:id/comments", authenticate, groupScope, projectCommentsRouter);
app.use("/api/projects/:id/deadlines", authenticate, groupScope, projectDeadlinesRouter);
app.use("/api/projects/:id/dependencies", authenticate, groupScope, projectDependenciesRouter);
app.use("/api/projects/:id/status-updates", authenticate, groupScope, projectStatusUpdatesRouter);
app.use("/api/status-updates", authenticate, groupScope, statusUpdatesRouter);

// When STATIC_DIR is set (Docker image), serve the compiled SPA from the
// same origin as the API and fall back to index.html for any unknown
// non-/api path so react-router's client-side routes resolve on reload.
if (config.staticDir) {
  const dir = path.resolve(config.staticDir);
  if (!existsSync(dir)) {
    console.warn(`[api] STATIC_DIR=${dir} does not exist; skipping SPA mount`);
  } else {
    const indexHtml = path.join(dir, "index.html");
    app.use(express.static(dir, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(indexHtml);
    });
    console.log(`[api] serving SPA from ${dir}`);
  }
}

app.use(notFound);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (auth=${config.authMode})`);
  startCron();
  bootstrapSuperAdmin().catch((err) => console.error("[auth] super-admin bootstrap failed", err));
});
