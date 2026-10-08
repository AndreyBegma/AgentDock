import { basename, dirname, join } from 'node:path';

/**
 * Slot session names (spec 11 D1, D12). Code Sentinel names a worker's tmux
 * session `cs-<slot>` (legacy) or `cs-<prefix>--<slot>` (plugin#11 D1). This
 * is the one place that parses them; other modules import it.
 */

const SESSION_PREFIX = 'cs-';
const SEPARATOR = '--';
/** `dispatch.sh` restricts slots to `[a-z0-9-]`; plugin#11 also rejects `--`. */
const SLOT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREFIX_MAX = 24;

export interface SessionName {
  slot: string;
  /** The repository prefix of `cs-<prefix>--<slot>`; null for a legacy name. */
  prefix: string | null;
}

/** `cs-i42-api` → `{ slot: 'i42-api', prefix: null }`; not a slot session → null. */
export const parseSessionName = (name: string): SessionName | null => {
  if (!name.startsWith(SESSION_PREFIX)) return null;
  const rest = name.slice(SESSION_PREFIX.length);
  const cut = rest.lastIndexOf(SEPARATOR);
  const prefix = cut === -1 ? null : rest.slice(0, cut);
  const slot = cut === -1 ? rest : rest.slice(cut + SEPARATOR.length);
  if (!SLOT.test(slot)) return null;
  if (prefix !== null && !SLOT.test(prefix)) return null;
  return { slot, prefix };
};

/**
 * The session prefix plugin#11 D2 derives from the main checkout's basename:
 * lower-cased, every run of non-`[a-z0-9]` one `-`, trimmed, cut to 24.
 */
export const sessionPrefix = (repoBasename: string): string =>
  repoBasename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PREFIX_MAX)
    .replace(/-+$/, '');

/** `<parent of root>/.wt-<basename of root>-<slot>`, `dispatch.sh`'s rule (D1). */
export const slotWorktreePath = (root: string, slot: string): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(dirname(trimmed), `.wt-${basename(trimmed)}-${slot}`);
};

/** The slot of a worktree path that follows the rule for `root`, else null. */
export const slotOfWorktree = (root: string, path: string): string | null => {
  const trimmed = root.replace(/\/+$/, '');
  if (dirname(path) !== dirname(trimmed)) return null;
  const lead = `.wt-${basename(trimmed)}-`;
  const name = basename(path);
  if (!name.startsWith(lead)) return null;
  const slot = name.slice(lead.length);
  return SLOT.test(slot) ? slot : null;
};

export interface SessionOwnership {
  /** The project's main checkout. */
  root: string;
  /** Slots whose worktree git lists for this root (`git worktree list`). */
  worktreeSlots: ReadonlySet<string>;
  /** `orchestrator.sessionPrefix` from `.code-analyzer-config.json`, when set. */
  configuredPrefix?: string | null;
}

/**
 * The slot a session is for in this project, or null when it is not one of
 * this project's (D12). A session belongs only when its slot's worktree is one
 * of the root's worktrees; a prefixed name must also carry this repository's
 * prefix, so `cs-other--i42` is never ours even beside our own `i42`.
 */
export const ownedSlot = (
  session: string,
  ownership: SessionOwnership,
): string | null => {
  const parsed = parseSessionName(session);
  if (!parsed || !ownership.worktreeSlots.has(parsed.slot)) return null;
  if (parsed.prefix === null) return parsed.slot;
  const expected =
    ownership.configuredPrefix ||
    sessionPrefix(basename(ownership.root.replace(/\/+$/, '')));
  return parsed.prefix === expected ? parsed.slot : null;
};
