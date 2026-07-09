import type { Project } from "./types";

/**
 * Small kit of hierarchy utilities shared by the roadmap tree, the
 * detail panel's parent picker, and the board's parent breadcrumb.
 *
 * All helpers accept the full flat `projects` array and derive their
 * indices on the fly — the collections are small (dozens to low
 * hundreds) and the extra pass is cheaper than threading a memoized
 * tree through every component that needs a lookup.
 */

/** Index projects by id for O(1) lookups. */
export function indexById(projects: Project[]): Map<string, Project> {
  const map = new Map<string, Project>();
  for (const p of projects) map.set(p.id, p);
  return map;
}

/** Build parent → direct children map. Empty entries are omitted. */
export function childrenByParent(projects: Project[]): Map<string, Project[]> {
  const map = new Map<string, Project[]>();
  for (const p of projects) {
    if (!p.parent_id) continue;
    const arr = map.get(p.parent_id) ?? [];
    arr.push(p);
    map.set(p.parent_id, arr);
  }
  return map;
}

/**
 * Walk up the parent chain from `startId`. Returns ancestors in
 * closest-first order (parent first, then grandparent…). Guards
 * against pathological cycles by capping at 32 hops.
 */
export function ancestors(startId: string, byId: Map<string, Project>): Project[] {
  const out: Project[] = [];
  let cursor = byId.get(startId)?.parent_id ?? null;
  let hops = 0;
  while (cursor && hops < 32) {
    const p = byId.get(cursor);
    if (!p) break;
    out.push(p);
    cursor = p.parent_id;
    hops++;
  }
  return out;
}

/**
 * Depth-first list of all descendants (transitive children) of
 * `rootId`. Useful for "all things under this epic" queries. Excludes
 * the root itself.
 */
export function descendants(rootId: string, kids: Map<string, Project[]>): Project[] {
  const out: Project[] = [];
  const stack = [...(kids.get(rootId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const child of kids.get(cur.id) ?? []) stack.push(child);
  }
  return out;
}

/**
 * Compute the depth of a project below the nearest epic ancestor.
 * Epics themselves are depth 0. Direct subtask of an epic → 1. And
 * so on. Used by the roadmap tree indentation.
 */
export function depthFromEpic(project: Project, byId: Map<string, Project>): number {
  let d = 0;
  let cursor: Project | undefined = project;
  while (cursor && cursor.parent_id) {
    d++;
    cursor = byId.get(cursor.parent_id);
    if (d > 32) break;
  }
  return d;
}

/**
 * Find the top-most epic ancestor of a project. If the project is
 * already an epic, returns itself. Returns null only in the pathological
 * "orphaned subtask" case (should never happen in practice — the DB
 * FK ON DELETE RESTRICT prevents it).
 */
export function rootEpic(project: Project, byId: Map<string, Project>): Project | null {
  let cursor: Project | undefined = project;
  let hops = 0;
  while (cursor && cursor.parent_id && hops < 32) {
    cursor = byId.get(cursor.parent_id);
    hops++;
  }
  return cursor ?? null;
}
