# PRD: Product Design Ticket Board

**Author:** Doug Hof, Ziff Davis Shopping — Design
**Status:** Draft — for migration to a new system
**Last updated:** 2026-09-28

## 1. Background

The design team (Doug, Isa, JiaJia, plus an Unassigned and a Completed bucket) currently tracks weekly design work on a lightweight Kanban-style board. It was prototyped quickly as a single-page web view backed by a shared JSON document store, and edited conversationally (a person describes a change in chat and it's written directly to the store) plus limited direct manipulation (drag-to-reorder). It has been in daily use for several weeks and now has real, current ticket data in it.

This PRD documents what the board actually does today so it can be rebuilt properly on a durable system (e.g., Jira, Asana, Linear, or a custom internal tool) rather than continuing to live as a prototype. It is a spec of observed/implemented behavior, not aspirational feature requests — open questions and gaps are called out explicitly in Section 7.

## 2. Goals

- Give the design team (and their stakeholders) a single, always-current view of who is working on what, and at what stage.
- Make status changes and reassignments fast and low-friction for the team.
- Support a "someone dropped off the team, work gets reassigned" and "new hire ramps up" lifecycle without losing history.
- Preserve a lightweight paper trail good enough to generate a weekly stakeholder update from.

## 3. Non-goals

- This is not a full project-management system — no time tracking, no sprints/cycles, no dependencies between tickets, no notifications/reminders.
- Not intended to replace Jira for engineering work. Several design tickets already carry a Jira key (see 5.1) for the corresponding engineering ticket — the design board and Jira are meant to coexist, not merge.

## 4. Users

| Role | Description |
|---|---|
| Design team member (Doug, Isa, JiaJia, and future hires) | Owns a column of tickets; needs to see their own queue and update status as work progresses. |
| Design lead (Doug) | Adds/reassigns tickets, resolves the Unassigned queue, marks things Completed, and is the one who reports status upward. |
| Stakeholder / viewer | Read-only interest in overall progress, primarily for weekly updates. Does not need edit access. |

## 5. Current functionality

### 5.1 Data model

Each ticket is a single record with these fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable identifier, currently a human-authored slug (e.g. `doug-3`, `jiajia-5`). A rebuild should use a real auto-generated ID instead. |
| `person` | string | yes | Who the ticket currently belongs to. One of the team member names, or the literal values `Unassigned` / `Completed` (see 7.1 for a problem with this). |
| `order` | integer | yes | Position within that person's column; lower sorts first. Renumbered on every reorder or reassignment. |
| `title` | string | yes | Ticket title, shown bold. |
| `sub` | string | no (may be empty) | One- or two-sentence description of the work, shown in italics under the title. |
| `status` | enum | yes | See 5.2. |
| `jira` | string | no | A real Jira issue key (e.g. `FAL-1105`). When present, renders as a linked badge. Only used for tickets that have a paired engineering ticket. |
| `links` | array of `{label, url}` | no | Arbitrary supporting links (a PRD, a prototype, a Figma file, an existing design). Zero or more per ticket. |
| `due` | string | no | Freeform due-date label. Supported by the renderer but not currently populated on any live ticket — confirm whether the new system should keep this. |

Every ticket currently in the live board (27 records as of this writing) can be exported for migration — see the accompanying `product-design-tickets-export.csv`.

### 5.2 Status taxonomy

Six statuses, each with a label and a distinct color used consistently across the board:

| Internal value | Label shown | Color family |
|---|---|---|
| `not` | Not started | Neutral gray |
| `on` | On-track | Blue |
| `risk` | At Risk | Red |
| `review` | In Review | Purple |
| `indev` | In Development | Teal |
| `done` | Completed | Green |

`indev` ("In Development") was added after initial launch when the team found "In Review" wasn't specific enough to distinguish "actively being built" from "waiting for design review." A rebuild should keep status as an extensible enum, not a boolean or two-state flag — the team has already needed to add one new state once.

### 5.3 Board layout

- Five fixed columns, in this order: **Doug**, **Isa**, **JiaJia**, **Unassigned**, **Completed**.
- Each column header shows the person's photo (a small circular avatar), their name, and a live count of tickets in that column.
- `Unassigned` and `Completed` are not people — they're status-like buckets that happen to be modeled as if they were columns/"people." This works today only because the team is small. See 7.1.
- Within a column, tickets are shown in ascending `order`, each as a card with:
  - A perforated "ticket stub" left edge showing the ticket's position number (`No.01`, `No.02`, ...) — cosmetic, derived from `order`, not a stable ID.
  - Title (struck through if status is `done`).
  - Description, if present.
  - A status pill (colored per 5.2).
  - A Jira badge, if `jira` is set.
  - Any supporting links.
  - A due-date label, if `due` is set.
- Columns render even when empty ("Nothing here yet").

### 5.4 Editing model

Today there is **no in-page form UI** for creating or editing tickets. Two ways changes get made:

1. **Conversational**: someone describes the change in natural language ("update the SERP design to in development," "add a ticket to Doug's board titled X," "move Y to JiaJia's board") and it's applied directly to the underlying record(s) — including creating new tickets with a next-available `order` in the target column, or moving a ticket by changing its `person`/`order`/`status` fields together.
2. **Direct manipulation**: a viewer can drag a ticket to reorder it within its own column (not across columns); the moment the drag ends, the new order for every ticket in that column is recalculated and saved.

Both paths write to the same underlying store, so either one is immediately visible to every other open viewer — there is no separate "publish" or "save" step.

### 5.5 Sync & multi-viewer behavior

- The board is backed by a single shared, persistent data store (documents keyed by ticket `id`), independent from the page's own code/layout.
- Every open viewer subscribes to that store and re-renders live when any ticket changes — no refresh needed, and no per-viewer local state that could drift.
- The store persists across changes to the page's visual design/layout — redesigning the board's look never touches the underlying ticket data, and vice versa.

## 6. Functional requirements for the rebuild

1. Support the data model in 5.1, with `status` as an extensible enum (must support adding a 7th value later without a schema migration).
2. Provide five default swimlanes matching 5.3, but see the recommendation in 7.1 about not conflating "person" with "bucket."
3. Ticket cards must show, at minimum: title, description, status (color-coded), optional linked Jira key, optional supporting links.
4. Support reordering within a column via drag-and-drop, persisted immediately.
5. Support moving a ticket to a different person's column (with status change in the same action, since that's the most common real edit — see the "SERP → In Development" and "Sales Calendar → JiaJia, On-track" examples in this board's history).
6. Real-time sync: a change made by one person should appear for every other viewer without a manual refresh.
7. Whatever interface replaces the "ask Claude in chat" editing path (a form, inline editing, etc.) needs to be at least as fast as describing the change in a sentence — this is the bar the current system set and the team has gotten used to.

## 7. Open questions / known gaps

These are things the current prototype either does imperfectly or doesn't decide, and should be resolved explicitly during the rebuild rather than carried over by default:

1. **"Completed" and "Unassigned" are not people, but are modeled as if they were.** When a ticket is marked done, its `person` field is overwritten (e.g., Isa's "Rewards email update" is now `person: "Completed"`), which loses the original owner. If "who completed this" or "what did Isa ship this quarter" ever matters, the new system should model status and assignee as two independent fields, with "Completed" and "Unassigned" as states/filters rather than swimlanes-that-overwrite-assignee.
2. **No audit trail.** There's a per-document `updatedAt` timestamp and version number, but no history of who changed what or a changelog view. If that matters for the rebuild, it needs its own design.
3. **No native create/edit UI.** Every addition or edit today goes through a person describing the change in natural language. Decide whether the rebuild keeps a conversational/assisted editing path, adds a full form-based UI, or both.
4. **Drag-and-drop is same-column only.** Cross-column drags (reassignment) aren't supported by direct manipulation today — only by asking for the change. Decide whether the rebuild should support drag-to-reassign directly.
5. **No permissions tiers.** Anyone who can open the board today can edit it (or drag tickets); there's no read-only stakeholder mode built in, even though stakeholders are a distinct user type (Section 4).
6. **No mobile/touch support** for drag-and-drop specifically (view-only works fine on mobile).
7. **`due` field is defined but unused.** Confirm with the team whether due dates are wanted before building UI for them.
8. **Jira relationship is informal.** A `jira` key is just a string + a link today; it isn't validated or kept in sync with the actual Jira issue's status/title. If Jira is the rebuild target, this could become a real two-way integration instead of a static reference.

## 8. Migration

An export of all 27 tickets currently on the live board is provided alongside this document (`product-design-tickets-export.csv`) — one row per ticket, with every field in 5.1. Use it as the seed data for the new system; it reflects the board's actual state as of 2026-09-28, not sample/placeholder data.
