import { differenceInCalendarDays, format } from "date-fns";
import { AlertTriangle, Calendar, ChevronRight, Map } from "lucide-react";
import type { Project, SwimLane, Team, User } from "../lib/types";
import type { ColorBy } from "../lib/viewState";
import { cn } from "../lib/cn";
import { computePhases } from "../lib/phaseCompute";
import { StatusPill } from "./StatusPill";
import { LaneMoveMenu } from "./LaneMoveMenu";
import { useProjectCurrentWeekStatus } from "../hooks/useProjectCurrentWeekStatus";

export function ProjectCard(props: {
  project: Project;
  colorBy: ColorBy;
  users: User[];
  teams: Team[];
  lanes: SwimLane[];
  onOpen?: () => void;
  isDragging?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLElement> & Record<string, unknown>;
}) {
  const { project, colorBy, users, teams, lanes, onOpen, isDragging, dragHandleProps } = props;
  const owner = users.find((u) => u.id === project.owner_id);
  const projectTeams = teams.filter((t) => project.teams.includes(t.id));
  const lane = lanes.find((l) => l.id === project.swim_lane_id);
  const accent = pickAccent({ colorBy, lane, teams: projectTeams, owner });

  const daysInStage = project.updated_at
    ? Math.max(0, differenceInCalendarDays(new Date(), new Date(project.updated_at)))
    : null;

  const status = useProjectCurrentWeekStatus(project.id);
  const needsStatus = !!lane?.requires_weekly_status;
  // Mirrors the Roadmap's own scheduled-vs-unscheduled check so the icon
  // and the Roadmap tab always agree about which cards appear where.
  const onRoadmap = computePhases(project).scheduled;

  // The whole tile is the drag surface AND the click-to-open target.
  // dnd-kit's PointerSensor is configured with distance:4 in BoardView,
  // so a plain click (no movement) falls through to onClick while a
  // drag past 4px starts a sortable move. Interactive children below
  // (the LaneMoveMenu) stop propagation so their clicks/pointerdowns
  // don't accidentally open the panel or start a drag.
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `Open ${project.title}` : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (!onOpen) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        // Kanban convention: pointer at rest (the tile is primarily a
        // link to details), grabbing only while a drag is actually
        // underway. `cursor-grab` at rest was misleading because it
        // implied "you can only drag", hiding the click affordance.
        "card-surface group relative overflow-hidden border-l-4 p-2.5 text-left transition select-none",
        onOpen ? "cursor-pointer" : "",
        dragHandleProps ? "active:cursor-grabbing" : "",
        isDragging ? "cursor-grabbing shadow-lg" : "hover:border-wp-red/40 hover:shadow-sm",
      )}
      style={{ borderLeftColor: accent }}
      {...(dragHandleProps ?? {})}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 pr-4">
          <div className="line-clamp-2 text-sm font-medium text-wp-ink">{project.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-wp-slate">
            {projectTeams.map((t) => (
              <span
                key={t.id}
                className="chip"
                style={{ borderColor: t.color, color: t.color }}
                title={`Team: ${t.name}`}
              >
                {t.name}
              </span>
            ))}
            {project.tags.slice(0, 3).map((t) => (
              <span key={t} className="chip">#{t}</span>
            ))}
          </div>
        </div>
        <ChevronRight size={14} className="mt-0.5 text-wp-slate opacity-0 group-hover:opacity-100" />
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-wp-slate">
        <div className="flex items-center gap-2">
          {owner ? (
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
              style={{ background: owner.color }}
              title={owner.name}
            >
              {initials(owner.name)}
            </span>
          ) : null}
          {project.target_date ? (
            <span className="inline-flex items-center gap-1">
              <Calendar size={11} /> {format(new Date(`${project.target_date}T00:00:00`), "MMM d")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {onRoadmap ? (
            <span
              className="inline-flex items-center text-wp-red"
              title="On roadmap"
              aria-label="On roadmap"
            >
              <Map size={12} />
            </span>
          ) : null}
          {needsStatus ? <StatusPill flag={status?.health_flag ?? "white"} completed={!!status?.completed} /> : null}
          {daysInStage !== null ? <span>{daysInStage}d</span> : null}
        </div>
      </div>

      {/*
        Non-drag move-to fallback (a11y — PRD §6). Isolated from the
        outer drag/click surface: stopping pointerdown prevents the
        sortable sensor from tracking movement, and stopping click
        prevents the tile's onClick from firing "open detail panel"
        when someone just wanted to pick a lane.
      */}
      <div
        className="mt-2 flex justify-end"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <LaneMoveMenu projectId={project.id} currentLaneId={project.swim_lane_id} lanes={lanes} />
      </div>

      {!status?.completed && needsStatus && new Date(status?.due_at ?? Date.now()) < new Date() && !status ? (
        <div className="mt-1 flex items-center gap-1 text-xs text-red-600">
          <AlertTriangle size={11} /> status overdue
        </div>
      ) : null}
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("");
}

function pickAccent(v: { colorBy: ColorBy; lane?: SwimLane; teams: Team[]; owner?: User }): string {
  if (v.colorBy === "team") return v.teams[0]?.color ?? "#94a3b8";
  if (v.colorBy === "owner") return v.owner?.color ?? "#94a3b8";
  return v.lane?.color ?? "#94a3b8";
}
