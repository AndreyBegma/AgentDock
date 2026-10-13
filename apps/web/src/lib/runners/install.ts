/**
 * The commands a first-time admin runs on the machine that holds the
 * repositories (issue #132). Fixed by the runner distribution; this module
 * only shows them, so the checklist and the pairing dialog say the same thing.
 */
export const INSTALL_COMMANDS = [
  {
    label: 'Homebrew',
    command: 'brew install andreybegma/tap/agentdock-runner',
  },
  { label: 'npm', command: 'npm i -g agentdock-runner' },
] as const;

/** Building from source, for a machine with neither. */
export const RUNNER_README_URL =
  'https://github.com/AndreyBegma/AgentDock/blob/main/apps/runner/README.md';

/** The foreground daemon. */
export const RUN_COMMAND = 'agentdock-runner run';

/** Proposes runtime profiles from `~/.claude-profiles`, `~/.claude` and `~/.codex`. */
export const PROFILES_DETECT_COMMAND =
  'agentdock-runner profiles --detect --write';

export type RunnerPlatform = 'macos' | 'linux' | 'unknown';

/**
 * The platform to give a hint for: the runner's own `os` when it reported one,
 * else a guess from the browser's user agent (the admin often installs on the
 * machine they are reading this on).
 */
export function platformOf(
  os: string | null | undefined,
  userAgent = '',
): RunnerPlatform {
  const known = (os ?? '').toLowerCase();
  if (known === 'darwin' || known === 'macos') return 'macos';
  if (known === 'linux') return 'linux';
  if (known) return 'unknown';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'macos';
  if (/Linux|X11/.test(userAgent) && !/Android/.test(userAgent)) return 'linux';
  return 'unknown';
}

/**
 * How to keep the daemon running across logouts and reboots.
 * `install-service` writes a systemd user unit, so it is Linux only (spec 5).
 */
export function keepOnlineCommands(platform: RunnerPlatform): string[] {
  switch (platform) {
    case 'macos':
      return ['brew services start agentdock-runner'];
    case 'linux':
      return ['agentdock-runner install-service'];
    case 'unknown':
      return [
        'agentdock-runner install-service',
        'brew services start agentdock-runner',
      ];
  }
}

/** The `--server` value of a pairing command, or null when it has none. */
export function serverOfCommand(command: string): string | null {
  return /--server\s+(\S+)/.exec(command)?.[1] ?? null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `localhost`, `127.0.0.1` or `::1`; an unparseable URL is not local. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The server the runner should pair with, as the pairing dialog shows it.
 * The primary value is built from the page's origin (`<origin>/api`, the
 * reverse proxy in production). The API's own `API_URL` is shown as well when
 * it differs and is not localhost — and also when the page itself is on
 * localhost, where `<origin>/api` is the Next rewrite rather than the API
 * (runner-protocol.md "Transport").
 */
export function pairingServers(
  origin: string,
  serverCommand: string,
): { primary: string; alternative: string | null } {
  const primary = `${origin.replace(/\/+$/, '')}/api`;
  const server = serverOfCommand(serverCommand);
  if (!server || server === primary) return { primary, alternative: null };
  if (isLocalUrl(origin)) return { primary: server, alternative: primary };
  return { primary, alternative: isLocalUrl(server) ? null : server };
}
