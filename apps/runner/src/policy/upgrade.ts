import type { Logger } from '../log';

/** A cached watch-list entry, as `runner.json` keeps it. */
export interface CachedProject {
  id: string;
  root: string;
}

/** `path` as one shell word: as is when it is plain, single-quoted otherwise. */
export const shellWord = (path: string): string =>
  /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;

/** The `allow-root` line for `roots`; the placeholder when there is none. */
export const allowRootCommand = (roots: readonly string[]): string =>
  `nautelle-runner policy allow-root ${
    roots.length > 0 ? roots.map(shellWord).join(' ') : '<dir>'
  }`;

/** The roots of the cached watch list, each once, in its order. */
export const cachedRoots = (projects: readonly CachedProject[]): string[] => [
  ...new Set(projects.map((p) => p.root)),
];

/**
 * #691: what a runner started on a `runner.json` with no `policy` block —
 * one written before 0.13 — tells the person. The default policy allows no
 * project root, so every project it watched is dropped; the notice lists them
 * and the commands that allow them. It never allows them itself (ADR-0047).
 */
export const upgradeNotice = (projects: readonly CachedProject[]): string => {
  const roots = cachedRoots(projects);
  const lines = [
    '',
    '!!! AgentDock runner 0.13 upgrade: runner.json has no `policy` block (ADR-0047).',
    '!!! This runner allows no project root yet, so it watches no project:',
    '!!! the Board, card collect and the Planner stop for every project until you allow them.',
  ];
  if (roots.length > 0) {
    lines.push(
      'It watched these before the upgrade:',
      ...projects.map((p) => `  ${p.root} (${p.id})`),
      'To watch them again, run on this machine:',
      '  nautelle-runner policy allow-root --watched',
      'or allow the directories yourself:',
      `  ${allowRootCommand(roots)}`,
    );
  } else {
    lines.push(
      'Allow the directories your projects live in, on this machine:',
      `  ${allowRootCommand([])}`,
    );
  }
  lines.push(
    'The runner does not allow them by itself: only you change its policy.',
    '',
  );
  return `${lines.join('\n')}\n`;
};

/** Logs the notice as one journal line and prints it to the terminal. */
export const reportUpgrade = (
  projects: readonly CachedProject[],
  log: Logger,
  stderr: (text: string) => void,
): void => {
  const roots = cachedRoots(projects);
  log.warn(
    'runner 0.13 upgrade: runner.json has no policy block, so no project is watched. Run `nautelle-runner policy allow-root --watched` on this machine',
    { roots, command: allowRootCommand(roots) },
  );
  stderr(upgradeNotice(projects));
};
