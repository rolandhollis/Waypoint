import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { format } from "date-fns";

import { api } from "../lib/api";
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
import { RoadmapCompactView } from "./RoadmapCompactView";

export type RoadmapSnapshotTeamPayload = {
  team_id: string;
  team_name: string;
  png_base64: string;
  in_development: string[];
};

export type RoadmapSnapshotRunResult = {
  recipients: number;
  sent: number;
  errors: number;
  dayOf: string;
  dryRun: boolean;
  testToSelf: boolean;
  subject: string;
  teamCount: number;
};

export function roadmapSnapshotSubject(now: Date = new Date()): string {
  return `Roadmap snapshot — ${format(now, "MMMM d, yyyy")}`;
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

type SendOpts = {
  testToSelf?: boolean;
  subject?: string;
  intro?: string;
  onProgress?: (message: string | null) => void;
};

type RoadmapSnapshotSendContextValue = {
  dataReady: boolean;
  teamCount: number;
  /** Capture Compact 3mo PNGs and POST the snapshot email. */
  sendRoadmapSnapshot: (opts?: SendOpts) => Promise<RoadmapSnapshotRunResult>;
  /**
   * If a status digest queued a follow-up for this group, capture
   * and send the roadmap snapshot, then clear the queue row.
   */
  drainPendingRoadmapSnapshot: (opts?: {
    onProgress?: (message: string | null) => void;
  }) => Promise<RoadmapSnapshotRunResult | null>;
  followUpStatus: string | null;
};

const RoadmapSnapshotSendContext =
  createContext<RoadmapSnapshotSendContextValue | null>(null);

export function useRoadmapSnapshotSend(): RoadmapSnapshotSendContextValue {
  const ctx = useContext(RoadmapSnapshotSendContext);
  if (!ctx) {
    throw new Error("useRoadmapSnapshotSend requires RoadmapSnapshotSendProvider");
  }
  return ctx;
}

/**
 * Owns the off-screen Compact capture host and the POST to
 * `/notifications/roadmap-snapshot/run`. Used by the manual admin
 * card and by the digest "Send now" follow-up.
 */
export function RoadmapSnapshotSendProvider({ children }: { children: ReactNode }) {
  const projectsQ = useProjects();
  const teamsQ = useTeams();
  const lanesQ = useSwimLanes();
  const usersQ = useUsers();
  const kpisQ = useKpis();

  const [activeTeam, setActiveTeam] = useState<Team | null>(null);
  const [followUpStatus, setFollowUpStatus] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sendingRef = useRef(false);

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

  const captureTeamSnapshots = useCallback(
    async (onProgress?: (message: string | null) => void): Promise<RoadmapSnapshotTeamPayload[]> => {
      const out: RoadmapSnapshotTeamPayload[] = [];
      for (let i = 0; i < sortedTeams.length; i += 1) {
        const team = sortedTeams[i]!;
        onProgress?.(`Capturing ${team.name} (${i + 1}/${sortedTeams.length})…`);
        flushSync(() => setActiveTeam(team));
        await settlePaint();

        const root = hostRef.current?.querySelector<HTMLElement>(
          '[data-roadmap-capture-root="true"]',
        );
        if (!root) {
          console.warn(`Roadmap snapshot: capture root missing for ${team.name}`);
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
          console.warn(`Roadmap snapshot failed for team ${team.name}`, err);
        }
      }
      flushSync(() => setActiveTeam(null));
      return out;
    },
    [sortedTeams, projectsQ.data, lanesQ.data],
  );

  const sendRoadmapSnapshot = useCallback(
    async (opts: SendOpts = {}): Promise<RoadmapSnapshotRunResult> => {
      if (sendingRef.current) {
        throw new Error("A roadmap snapshot send is already in progress");
      }
      if (!dataReady) {
        throw new Error("Roadmap data is still loading");
      }
      if (sortedTeams.length === 0) {
        throw new Error("No teams to include in the roadmap snapshot");
      }

      sendingRef.current = true;
      const onProgress = opts.onProgress;
      try {
        const teams = await captureTeamSnapshots(onProgress);
        if (teams.length === 0) {
          throw new Error("Could not capture any team roadmap images");
        }
        onProgress?.(
          opts.testToSelf
            ? "Sending test email…"
            : `Sending ${teams.length} team image${teams.length === 1 ? "" : "s"}…`,
        );
        const result = await api<RoadmapSnapshotRunResult>(
          "/notifications/roadmap-snapshot/run",
          {
            method: "POST",
            body: JSON.stringify({
              dry_run: false,
              test_to_self: Boolean(opts.testToSelf),
              subject: (opts.subject ?? roadmapSnapshotSubject()).trim(),
              intro: opts.intro?.trim() || undefined,
              teams,
            }),
          },
        );
        return result;
      } finally {
        flushSync(() => setActiveTeam(null));
        onProgress?.(null);
        sendingRef.current = false;
      }
    },
    [captureTeamSnapshots, dataReady, sortedTeams.length],
  );

  const drainPendingRoadmapSnapshot = useCallback(
    async (opts?: {
      onProgress?: (message: string | null) => void;
    }): Promise<RoadmapSnapshotRunResult | null> => {
      if (sendingRef.current || !dataReady) return null;
      const pending = await api<{
        pending: { requestedAt: string; digestWeekOf: string | null } | null;
      }>("/notifications/roadmap-snapshot/pending");
      if (!pending.pending) return null;

      const onProgress = (msg: string | null) => {
        setFollowUpStatus(msg);
        opts?.onProgress?.(msg);
      };
      try {
        onProgress("Digest follow-up: capturing roadmap snapshot…");
        const result = await sendRoadmapSnapshot({
          subject: roadmapSnapshotSubject(),
          onProgress,
        });
        // run endpoint clears the queue on success; ack as a safety net
        await api("/notifications/roadmap-snapshot/pending/ack", {
          method: "POST",
          body: JSON.stringify({}),
        }).catch(() => undefined);
        onProgress(
          result.errors > 0
            ? `Roadmap snapshot finished with errors (sent ${result.sent}, errors ${result.errors}).`
            : `Roadmap snapshot sent to ${result.sent} recipient${result.sent === 1 ? "" : "s"}.`,
        );
        return result;
      } catch (err) {
        onProgress(null);
        throw err;
      }
    },
    [dataReady, sendRoadmapSnapshot],
  );

  // Fallback: drain follow-ups queued when server-side capture failed.
  // Primary path is headless Chromium after the status digest cron.
  useEffect(() => {
    if (!dataReady) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || sendingRef.current) return;
      try {
        await drainPendingRoadmapSnapshot();
      } catch (err) {
        console.warn("Roadmap snapshot follow-up failed", err);
        setFollowUpStatus(
          err instanceof Error
            ? `Roadmap snapshot follow-up failed: ${err.message}`
            : "Roadmap snapshot follow-up failed.",
        );
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [dataReady, drainPendingRoadmapSnapshot]);

  const value = useMemo(
    () => ({
      dataReady,
      teamCount: sortedTeams.length,
      sendRoadmapSnapshot,
      drainPendingRoadmapSnapshot,
      followUpStatus,
    }),
    [
      dataReady,
      sortedTeams.length,
      sendRoadmapSnapshot,
      drainPendingRoadmapSnapshot,
      followUpStatus,
    ],
  );

  return (
    <RoadmapSnapshotSendContext.Provider value={value}>
      {children}
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
    </RoadmapSnapshotSendContext.Provider>
  );
}
