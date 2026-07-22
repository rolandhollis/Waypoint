import { differenceInCalendarDays, format } from "date-fns";
import { AlertTriangle, Calendar, ChevronRight, Layers, Map as MapIcon } from "lucide-react";
import { useRef } from "react";
import type { Project, SwimLane, Team, User } from "../lib/types";
import type { ColorBy } from "../lib/viewState";
import { cn } from "../lib/cn";
import { pillTextColor, tint } from "../lib/colors";
import { computePhases } from "../lib/phaseCompute";
import { StatusPill } from "./StatusPill";
import { LaneMoveMenu } from "./LaneMoveMenu";
import {
  BoardCardQuickActions,
  type BoardCardQuickActionsHandle,
  type BoardCardQuickActionsProps,
} from "./BoardCardQuickActions";
import { useProjectCurrentWeekStatus } from "../hooks/useProjectCurrentWeekStatus";

export function ProjectCard(props: {
  project: Project;
  colorBy: ColorBy;
  users: User[];
  teams: Team[];
  lanes: SwimLane[];
  /** Full project list — used to look up the parent's title for
   *  subtask cards. Optional so the DragOverlay use case (which just
   *  clones the card mid-drag) can skip passing it. */
  allProjects?: Project[];
  onOpen?: () => void;
  isDragging?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLElement> & Record<string, unknown>;
  /** When provided, renders the ⋮ quick-actions trigger in the card's
   *  top-right AND wires a right-click handler on the card root that
   *  opens the same menu at the pointer. Omitted for viewers (BoardView
   *  passes undefined when useCanWrite() is false) and for the
   *  DragOverlay clone, both of which should show a static card. */
  quickActions?: BoardCardQuickActionsProps;
}) {
  const { project, colorBy, users, teams, lanes, allProjects, onOpen, isDragging, dragHandleProps, quickActions } = props;
  // Imperative handle: right-click on the card root fires openAt(x, y)
  // on the quick-actions menu, which opens it anchored to the pointer.
  // Left-click on the ⋮ trigger uses Radix's default anchor and
  // ignores this ref.
  const quickActionsRef = useRef<BoardCardQuickActionsHandle>(null);
  const owner = users.find((u) => u.id === project.owner_id);
  // Iterate `project.teams` (the ranked list) and look up each team
  // in the catalog so the chip sequence mirrors the PM's chosen
  // primary → secondary → tertiary order.
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const projectTeams = project.teams
    .map((id) => teamsById.get(id))
    .filter((t): t is Team => !!t);
  const lane = lanes.find((l) => l.id === project.swim_lane_id);
  const accent = pickAccent({ colorBy, lane, teams: projectTeams, owner });
  const parent = project.parent_id
    ? allProjects?.find((p) => p.id === project.parent_id)
    : undefined;
  const isEpic = project.type === "epic";

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
      // Right-click power-user shortcut. Only wired when quickActions
      // is provided (i.e. we're on the Board AND the caller can
      // write). Preventing the default browser context menu is
      // required both to open our own AND to keep pointer coords
      // matching what the user clicked (default would deselect our
      // active-card treatment). Viewers get the browser's native
      // context menu falls through untouched.
      onContextMenu={
        quickActions
          ? (e) => {
              e.preventDefault();
              quickActionsRef.current?.openAt(e.clientX, e.clientY);
            }
          : undefined
      }
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
          {/* Parent breadcrumb on subtasks — small so it doesn't compete
              with the title but present so it's obvious what tree the
              card belongs to. Only rendered when we can resolve the
              parent (allProjects passed). */}
          {parent ? (
            <div className="mb-0.5 truncate text-[11px] text-wp-slate/80">
              ↳ {parent.title}
            </div>
          ) : null}
          <div className="flex items-start gap-1 text-sm font-medium text-wp-ink">
            {isEpic ? (
              <span
                className="inline-flex shrink-0 items-center text-wp-red"
                title="Epic"
                aria-label="Epic"
              >
                <Layers size={12} />
              </span>
            ) : null}
            <span className="min-w-0 flex-1 whitespace-normal break-words">{project.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-wp-slate">
            {projectTeams.map((t) => {
              // Colored text-only chips (`color: t.color` on white) ran
              // straight into a readability wall for light team colors
              // like yellow. Swap to tint-bg + colored border + a
              // darkened team-hue text via `pillTextColor` so every
              // team hex reads cleanly against the card surface while
              // still communicating the team's color identity.
              const bg = tint(t.color, 0.14);
              return (
                <span
                  key={t.id}
                  className="chip"
                  style={{ borderColor: t.color, background: bg, color: pillTextColor(t.color) }}
                  title={`Team: ${t.name}`}
                >
                  {t.name}
                </span>
              );
            })}
            {project.tags.slice(0, 3).map((t) => (
              <span key={t} className="chip">#{t}</span>
            ))}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-start gap-0.5">
          {quickActions ? (
            <BoardCardQuickActions ref={quickActionsRef} {...quickActions} />
          ) : null}
          <ChevronRight size={14} className="mt-1 text-wp-slate opacity-0 group-hover:opacity-100" />
        </div>
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
              <MapIcon size={12} />
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
