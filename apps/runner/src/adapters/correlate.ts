import { basename, dirname } from 'node:path';
import type { WatchedProject } from '@agentdock/shared/protocol';
import type { Correlation } from './types';

const trimSlash = (path: string): string =>
  path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * The project and slot of a session from its `cwd` (D6). Path arithmetic
 * only, nothing is read from disk:
 * - inside `<parent of root>/.wt-<basename of root>-<slot>`, the worktree
 *   `dispatch.sh` creates for a slot: that project and that slot;
 * - else the deepest watched root that is `cwd` or one of its ancestors;
 * - else nothing.
 * A longer repository name is tried first, so `.wt-app-web-i1` belongs to a
 * project `app-web` rather than to slot `web-i1` of a project `app`.
 */
export const correlateCwd = (
  cwd: string,
  projects: readonly WatchedProject[],
): Correlation => {
  const path = trimSlash(cwd);
  const roots = projects.map((p) => ({ id: p.id, root: trimSlash(p.root) }));

  const byName = [...roots].sort(
    (a, b) => basename(b.root).length - basename(a.root).length,
  );
  for (const { id, root } of byName) {
    const prefix = `${dirname(root)}/.wt-${basename(root)}-`.replace(
      /^\/\//,
      '/',
    );
    if (!path.startsWith(prefix)) continue;
    const slot = path.slice(prefix.length).split('/')[0];
    if (slot) return { projectId: id, slot };
  }

  let best: { id: string; root: string } | null = null;
  for (const candidate of roots) {
    if (!isWithin(path, candidate.root)) continue;
    if (!best || candidate.root.length > best.root.length) best = candidate;
  }
  return best ? { projectId: best.id } : {};
};
