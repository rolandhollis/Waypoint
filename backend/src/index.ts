import "express-async-errors";
import { existsSync } from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { authenticate } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { usersRouter } from "./routes/users.js";
import { swimLanesRouter } from "./routes/swimLanes.js";
import { teamsRouter } from "./routes/teams.js";
import { projectsRouter } from "./routes/projects.js";
import { projectStatusUpdatesRouter, statusUpdatesRouter } from "./routes/statusUpdates.js";
import { startCron } from "./jobs/weeklyStatus.js";

const app = express();

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, auth: config.authMode }));

// Unauthenticated: mock roster for the dev switcher. In mock mode only.
app.use("/api/users", (req, res, next) => {
  if (req.method === "GET" && req.path === "/mock-roster" && config.authMode === "mock") {
    return next();
  }
  return authenticate(req, res, next);
}, usersRouter);

app.use("/api/swim-lanes", authenticate, swimLanesRouter);
app.use("/api/teams", authenticate, teamsRouter);
app.use("/api/projects", authenticate, projectsRouter);
app.use("/api/projects/:id/status-updates", authenticate, projectStatusUpdatesRouter);
app.use("/api/status-updates", authenticate, statusUpdatesRouter);

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
});
