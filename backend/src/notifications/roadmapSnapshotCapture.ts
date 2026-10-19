import { existsSync } from "node:fs";
import { format } from "date-fns";
import puppeteer, { type Browser } from "puppeteer-core";

import { config } from "../config.js";
import { query } from "../db/pool.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import type { UserRow } from "../types.js";
import {
  clearRoadmapSnapshotFollowup,
  enqueueRoadmapSnapshotFollowup,
  runRoadmapSnapshotEmail,
  type RoadmapSnapshotRunResult,
  type RoadmapSnapshotTeamImage,
} from "./roadmapSnapshotEmail.js";

/**
 * Server-side roadmap snapshot: headless Chromium loads the SPA capture
 * page (same Compact PNG pipeline as the admin UI), then we email the
 * digest roster. Used by the weekly status digest cron so send no longer
 * depends on an admin browser tab being open.
 */

type CaptureWindowResult =
  | {
      ok: true;
      teams: Array<{
        team_id: string;
        team_name: string;
        png_base64: string;
        in_development: string[];
      }>;
    }
  | { ok: false; error: string };

async function pickCaptureActor(groupId: string): Promise<UserRow | null> {
  const { rows: admins } = await query<UserRow>(
    `SELECT u.*
       FROM users u
       JOIN user_groups ug ON ug.user_id = u.id
      WHERE ug.group_id = $1 AND ug.role = 'admin'
      ORDER BY u.is_super_user DESC NULLS LAST, u.created_at ASC
      LIMIT 1`,
    [groupId],
  );
  if (admins[0]) return admins[0]!;

  const { rows: supers } = await query<UserRow>(
    `SELECT * FROM users
      WHERE is_super_user = TRUE
      ORDER BY created_at ASC
      LIMIT 1`,
  );
  return supers[0] ?? null;
}

export type CaptureBootstrap = {
  actorUserId: string;
  sessionId: string | null;
  groupId: string;
};

/** Create a short session for an admin of the group and point them at it. */
export async function bootstrapRoadmapCaptureSession(
  groupId: string,
): Promise<CaptureBootstrap> {
  const actor = await pickCaptureActor(groupId);
  if (!actor) {
    throw new Error(`No admin user available to capture roadmaps for group ${groupId}`);
  }

  await query(
    `UPDATE users SET current_group_id = $1, updated_at = NOW() WHERE id = $2`,
    [groupId, actor.id],
  );

  let sessionId: string | null = null;
  if (config.authMode === "password") {
    const session = await createSession(actor.id, "roadmap-snapshot-capture", false);
    sessionId = session.id;
  }

  return { actorUserId: actor.id, sessionId, groupId };
}

function chromiumExecutablePath(): string | null {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (fromEnv) return fromEnv;
  // Common paths on Debian/Ubuntu and macOS local installs.
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = chromiumExecutablePath();
  if (!executablePath) {
    throw new Error(
      "Chromium not found — set PUPPETEER_EXECUTABLE_PATH or install chromium in the image",
    );
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none",
    ],
  });
}

function captureBaseUrl(): string {
  const raw =
    process.env.ROADMAP_CAPTURE_BASE_URL?.trim() ||
    `http://127.0.0.1:${config.port}`;
  return raw.replace(/\/$/, "");
}

async function captureTeamImages(groupId: string): Promise<RoadmapSnapshotTeamImage[]> {
  const bootstrap = await bootstrapRoadmapCaptureSession(groupId);
  const base = captureBaseUrl();
  // `actor` seeds mock-mode identity before React's login gate.
  const url = `${base}/internal/roadmap-snapshot-capture?actor=${encodeURIComponent(bootstrap.actorUserId)}`;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

    // Prefer `url` over `domain` so IP hosts (127.0.0.1) work.
    if (bootstrap.sessionId) {
      await page.setCookie({
        name: SESSION_COOKIE,
        value: encodeURIComponent(bootstrap.sessionId),
        url: base,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
    }

    // Mock-mode identity: zustand persist cookie + request header.
    await page.setCookie({
      name: "waypoint.mockUserId",
      value: JSON.stringify({
        state: { mockUserId: bootstrap.actorUserId },
        version: 0,
      }),
      url: base,
      path: "/",
      sameSite: "Lax",
    });
    await page.setExtraHTTPHeaders({
      "x-mock-user-id": bootstrap.actorUserId,
    });

    await page.goto(url, { waitUntil: "networkidle0", timeout: 120_000 });

    await page.waitForFunction(
      () =>
        typeof (window as unknown as { __ROADMAP_SNAPSHOT_CAPTURE?: unknown })
          .__ROADMAP_SNAPSHOT_CAPTURE !== "undefined",
      { timeout: 180_000 },
    );

    const result = await page.evaluate(
      () =>
        (window as unknown as { __ROADMAP_SNAPSHOT_CAPTURE: CaptureWindowResult })
          .__ROADMAP_SNAPSHOT_CAPTURE,
    );

    if (!result || !result.ok) {
      throw new Error(result?.error || "Capture page returned no result");
    }

    return result.teams.map((t) => ({
      teamId: t.team_id,
      teamName: t.team_name,
      png: Buffer.from(t.png_base64, "base64"),
      inDevelopment: t.in_development ?? [],
    }));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function roadmapSnapshotSubject(now: Date = new Date()): string {
  return `Roadmap snapshot — ${format(now, "MMMM d, yyyy")}`;
}

/**
 * Capture Compact PNGs and send the roadmap snapshot email for one group.
 * On failure, enqueues the browser follow-up so an admin tab can still drain.
 */
export async function runScheduledRoadmapSnapshot(
  groupId: string,
  opts?: { weekOf?: string | null; dryRun?: boolean },
): Promise<RoadmapSnapshotRunResult | null> {
  if (process.env.ROADMAP_CAPTURE_ENABLED === "false") {
    console.log(`[roadmap-snapshot] capture disabled — enqueueing browser follow-up for ${groupId}`);
    if (!opts?.dryRun) {
      await enqueueRoadmapSnapshotFollowup(groupId, opts?.weekOf ?? null);
    }
    return null;
  }

  try {
    const teams = await captureTeamImages(groupId);
    const result = await runRoadmapSnapshotEmail({
      scopeGroupId: groupId,
      subject: roadmapSnapshotSubject(),
      teams,
      dryRun: Boolean(opts?.dryRun),
    });
    if (!opts?.dryRun && result.sent > 0) {
      await clearRoadmapSnapshotFollowup(groupId);
    }
    return result;
  } catch (err) {
    console.error(`[roadmap-snapshot] scheduled capture failed for ${groupId}:`, err);
    if (!opts?.dryRun) {
      try {
        await enqueueRoadmapSnapshotFollowup(groupId, opts?.weekOf ?? null);
        console.log(
          `[roadmap-snapshot] enqueued browser follow-up after capture failure for ${groupId}`,
        );
      } catch (enqueueErr) {
        console.error(
          `[roadmap-snapshot] failed to enqueue follow-up for ${groupId}:`,
          enqueueErr,
        );
      }
    }
    throw err;
  }
}
