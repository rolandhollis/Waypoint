import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { RoadmapCompactView } from "../components/RoadmapCompactView";
import { captureRoadmapPng } from "../lib/captureRoadmapPng";
import { matchesTeamFilter } from "../lib/filtering";
import {
  useKpis,
  useProjects,
  useSwimLanes,
  useTeams,
  useUsers,
} from "../lib/queries";
import { classifyLane } from "../lib/roadmapUpdateDeck";
import type { Project, SwimLane, Team } from "../lib/types";

/**
 * Headless-only page used by the server (Puppeteer) after the weekly
 * status digest. Renders each team's Compact 3-month roadmap off-screen,
 * captures PNGs, and exposes them on `window.__ROADMAP_SNAPSHOT_CAPTURE`
 * for the worker to read.
 */

export type RoadmapSnapshotCapturePayload = {
  ok: true;
  teams: Array<{
    team_id: string;
    team_name: string;
    png_base64: string;
    in_development: string[];
  }>;
};

export type RoadmapSnapshotCaptureError = {
  ok: false;
  error: string;
};

declare global {
  interface Window {
    __ROADMAP_SNAPSHOT_CAPTURE?: RoadmapSnapshotCapturePayload | RoadmapSnapshotCaptureError;
  }
}

function inDevelopmentTitles(
  projects: Project[],
  teamId: string,
  lanes: SwimLane[],
): string[] {
  const laneById = new Map(lanes.map((l) => [l.id, l] as const));
  return projects
    .filter((p) => {
      if (p.deleted_at) return false;
      if (p.type !== "epic") return false;
      if (!matchesTeamFilter(p.teams, [teamId])) return false;
      const lane = p.swim_lane_id ? laneById.get(p.swim_lane_id) : undefined;
      return classifyLane(lane) === "development";
    })
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
    .map((p) => p.title);
}

function visibleRoadmapProjects(
  projects: Project[],
  lanes: { id: string; is_archive?: boolean; name: string }[],
): Project[] {
  const laneById = new Map(lanes.map((l) => [l.id, l] as const));
  return projects.filter((p) => {
    if (p.deleted_at) return false;
    if (p.hidden_from_roadmap) return false;
    if (!p.swim_lane_id) return true;
    const lane = laneById.get(p.swim_lane_id);
    if (!lane) return true;
    if (lane.is_archive) return false;
    if (lane.name.trim().toLowerCase() === "parking lot") return false;
    return true;
  });
}

async function settlePaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 80);
  });
}

export function RoadmapSnapshotCapturePage() {
  const projectsQ = useProjects();
  const teamsQ = useTeams();
  const lanesQ = useSwimLanes();
  const usersQ = useUsers();
  const kpisQ = useKpis();

  const [activeTeam, setActiveTeam] = useState<Team | null>(null);
  const [status, setStatus] = useState("Loading roadmap data…");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ranRef = useRef(false);

  const sortedTeams = useMemo(() => {
    const teams = teamsQ.data ?? [];
    return [...teams].sort(
      (a, b) => a.order - b.order || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [teamsQ.data]);

  const baseProjects = useMemo(
    () => visibleRoadmapProjects(projectsQ.data ?? [], lanesQ.data ?? []),
    [projectsQ.data, lanesQ.data],
  );

  const captureProjects = useMemo(() => {
    if (!activeTeam) return [];
    return baseProjects.filter((p) => matchesTeamFilter(p.teams, [activeTeam.id]));
  }, [activeTeam, baseProjects]);

  const dataReady =
    !!projectsQ.data && !!teamsQ.data && !!lanesQ.data && !!usersQ.data && !!kpisQ.data;

  useEffect(() => {
    if (!dataReady || ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      try {
        if (sortedTeams.length === 0) {
          window.__ROADMAP_SNAPSHOT_CAPTURE = {
            ok: false,
            error: "No teams to include in the roadmap snapshot",
          };
          setStatus("No teams");
          return;
        }

        const out: RoadmapSnapshotCapturePayload["teams"] = [];
        for (let i = 0; i < sortedTeams.length; i += 1) {
          const team = sortedTeams[i]!;
          setStatus(`Capturing ${team.name} (${i + 1}/${sortedTeams.length})…`);
          flushSync(() => setActiveTeam(team));
          await settlePaint();

          const root = hostRef.current?.querySelector<HTMLElement>(
            '[data-roadmap-capture-root="true"]',
          );
          if (!root) {
            console.warn(`Roadmap snapshot capture: root missing for ${team.name}`);
            continue;
          }
          try {
            const dataUrl = await captureRoadmapPng(root, { pixelRatio: 1.5 });
            const png_base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
            if (!png_base64) continue;
            out.push({
              team_id: team.id,
              team_name: team.name,
              png_base64,
              in_development: inDevelopmentTitles(
                projectsQ.data ?? [],
                team.id,
                lanesQ.data ?? [],
              ),
            });
          } catch (err) {
            console.warn(`Roadmap snapshot capture failed for ${team.name}`, err);
          }
        }

        flushSync(() => setActiveTeam(null));

        if (out.length === 0) {
          window.__ROADMAP_SNAPSHOT_CAPTURE = {
            ok: false,
            error: "Could not capture any team roadmap images",
          };
          setStatus("Capture failed");
          return;
        }

        window.__ROADMAP_SNAPSHOT_CAPTURE = { ok: true, teams: out };
        setStatus(`Captured ${out.length} team image(s)`);
      } catch (err) {
        window.__ROADMAP_SNAPSHOT_CAPTURE = {
          ok: false,
          error: err instanceof Error ? err.message : "Capture failed",
        };
        setStatus("Capture failed");
      }
    })();
  }, [dataReady, sortedTeams, projectsQ.data, lanesQ.data]);

  return (
    <div className="min-h-screen bg-white p-6 text-sm text-wp-ink">
      <p data-roadmap-capture-status="true">{status}</p>
      {activeTeam && dataReady ? (
        <div
          ref={hostRef}
          aria-hidden
          className="pointer-events-none fixed left-[-10000px] top-0 z-[-1] bg-white"
          style={{ width: 1600 }}
        >
          <RoadmapCompactView
            projects={captureProjects}
            lanes={lanesQ.data ?? []}
            teams={teamsQ.data ?? []}
            users={usersQ.data ?? []}
            kpis={kpisQ.data ?? []}
            colorBy="team"
            groupBy="none"
            zoom="3mo"
            pdfMode
            onOpen={() => {}}
          />
        </div>
      ) : null}
    </div>
  );
}
