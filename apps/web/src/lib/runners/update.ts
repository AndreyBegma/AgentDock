import { type LocalRunner, RUNNER_NPM_PACKAGE } from '@nautelle/shared';

/**
 * C-328: the notice a user sees when a runner they are the local user of is
 * older than the latest `nautelle-runner` release. The API compares the
 * versions (`update` on `GET /runners/local`); this module only decides what
 * to show and remembers a dismissal.
 */

/** What changed in each runner release. */
export const RUNNER_CHANGELOG_URL =
  'https://github.com/AndreyBegma/Nautelle/blob/main/apps/runner/CHANGELOG.md';

/** Installs exactly the release the notice names. */
export const runnerUpdateCommand = (latest: string): string =>
  `npm i -g ${RUNNER_NPM_PACKAGE}@${latest}`;

/**
 * Restarts the service `install-service` wrote, so the new binary runs: the
 * systemd user unit `nautelle-runner` on Linux, the launchd agent
 * `com.nautelle.runner` on macOS (ADR-0017).
 */
export const RUNNER_RESTART_COMMANDS = [
  {
    label: 'Linux (systemd)',
    command: 'systemctl --user restart nautelle-runner',
  },
  {
    label: 'macOS (launchd)',
    command: 'launchctl kickstart -k gui/$(id -u)/com.nautelle.runner',
  },
] as const;

/** Installed with Homebrew instead: upgrade and restart in one line. */
export const RUNNER_BREW_UPDATE_COMMAND =
  'brew upgrade nautelle-runner && brew services restart nautelle-runner';

/** The release the user dismissed the notice for, per browser. */
export const DISMISSED_RELEASE_KEY = 'nautelle.runnerUpdate.dismissed';

export interface RunnerUpdateNotice {
  /** The release every listed runner is behind. */
  latest: string;
  /** One sentence per outdated runner, e.g. `Your runner desk is on 0.14.0 — 0.15.0 is out.` */
  lines: string[];
}

/**
 * The notice for the caller's runners, or null when none is outdated — a
 * runner on the release, one that never reported a version, or every runner
 * before the API knows the release — or when the user dismissed this
 * release. A dismissal lasts until the next release.
 */
export function runnerUpdateNotice(
  runners: readonly LocalRunner[],
  dismissed: string | null,
): RunnerUpdateNotice | null {
  const outdated = runners.filter((runner) => runner.update?.outdated);
  const latest = outdated[0]?.update?.latest;
  if (!latest || latest === dismissed) return null;
  return {
    latest,
    lines: outdated.map(
      (runner) =>
        `Your runner ${runner.hostname ?? runner.name} is on ${runner.update?.current} — ${latest} is out.`,
    ),
  };
}

type DismissStorage = Pick<Storage, 'getItem' | 'setItem'>;

const localStorageOrNull = (): DismissStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The dismissed release; null when none was, or storage is blocked. */
export function readDismissedRelease(
  storage: DismissStorage | null = localStorageOrNull(),
): string | null {
  try {
    return storage?.getItem(DISMISSED_RELEASE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Remembers the dismissal; when storage is blocked it lasts for this page. */
export function storeDismissedRelease(
  latest: string,
  storage: DismissStorage | null = localStorageOrNull(),
): void {
  try {
    storage?.setItem(DISMISSED_RELEASE_KEY, latest);
  } catch {
    // Not remembered: the notice comes back on the next load.
  }
}
