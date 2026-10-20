import { pairCommand } from '@nautelle/shared';

/**
 * The commands a first-time admin runs on the machine that holds the
 * repositories (issue #132). Fixed by the runner distribution; this module
 * only shows them, so the checklist, the pairing dialog and `/install` say the
 * same thing.
 */
export const INSTALL_COMMANDS = [
  {
    label: 'Homebrew',
    command: 'brew install andreybegma/tap/nautelle-runner',
  },
  { label: 'npm', command: 'npm i -g nautelle-runner' },
] as const;

/** The npm package installed with Bun instead; shown on `/install` only. */
export const BUN_INSTALL_COMMAND = 'bun add -g nautelle-runner';

/** Where npm puts global packages; their commands are in its `bin`. */
export const NPM_PREFIX_COMMAND = 'npm prefix -g';

/** Prints the version and the target, e.g. `0.1.0 darwin-arm64`. */
export const VERSION_COMMAND = 'nautelle-runner version';

/** The prebuilt targets (ADR-0017). */
export const RUNNER_PLATFORMS = [
  'macOS arm64',
  'macOS x64',
  'Linux arm64',
  'Linux x64',
] as const;

/** What the runner looks for on its machine and reports as capabilities. */
export const RUNNER_REQUIREMENTS = [
  { tool: 'tmux', why: 'every run gets its own tmux session' },
  { tool: 'git', why: 'every run gets its own worktree' },
  { tool: 'gh', why: 'the GitHub CLI, signed in with gh auth login' },
  {
    tool: 'Claude Code and/or Codex',
    why: 'the runtimes the agents run on (claude, codex)',
  },
] as const;

/** The public page about the runner (issue #145). */
export const INSTALL_PATH = '/install';

/** The query parameter that opens Runners' Add runner dialog. */
export const ADD_RUNNER_PARAM = 'add';

/** Runners, with the Add runner dialog open. */
export const ADD_RUNNER_PATH = `/admin/runners?${ADD_RUNNER_PARAM}=1`;

/** Stands in for the code an administrator generates. */
export const PAIRING_CODE_PLACEHOLDER = 'XXXX-XXXX';

/** Building from source, for a machine with neither. */
export const RUNNER_README_URL =
  'https://github.com/AndreyBegma/AgentDock/blob/main/apps/runner/README.md';

/** The foreground daemon. */
export const RUN_COMMAND = 'nautelle-runner run';

/** Proposes runtime profiles from `~/.claude-profiles`, `~/.claude` and `~/.codex`. */
export const PROFILES_DETECT_COMMAND =
  'nautelle-runner profiles --detect --write';

/** The anchor of "Connect Claude Code sessions" on `/install` (#281 D6). */
export const CLAUDE_CODE_PATH = `${INSTALL_PATH}#claude-code`;

/** Lists the runtime profiles; the first column is the key `setup` takes. */
export const PROFILES_LIST_COMMAND = 'nautelle-runner profiles';

/** Installs the agentdock plugin into one Claude profile (spec 201 D21). */
export const SETUP_CLAUDE_COMMAND =
  'nautelle-runner setup claude --profile <key>';

/** What `setup claude` would change, without changing it. */
export const SETUP_CLAUDE_DRY_RUN_COMMAND = `${SETUP_CLAUDE_COMMAND} --dry-run`;

/** Takes the plugin and the telemetry setting out of the profile again. */
export const SETUP_CLAUDE_UNINSTALL_COMMAND = `${SETUP_CLAUDE_COMMAND} --uninstall`;

/** Shows the runner's config, connectivity and spool. */
export const RUNNER_STATUS_COMMAND = 'nautelle-runner status';

/**
 * How to keep the daemon running across logouts and reboots. It depends on how
 * the runner was installed, not on the OS (ADR-0017): Homebrew runs it as a
 * brew service; `install-service` writes a systemd user unit on Linux and a
 * launchd agent on macOS.
 */
export const KEEP_ONLINE_COMMANDS = [
  {
    label: 'Installed with Homebrew',
    command: 'brew services start nautelle-runner',
  },
  {
    label: 'Installed with npm',
    command: 'nautelle-runner install-service',
  },
] as const;

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

/**
 * Every command `/install` shows for a page served from `origin`. The server
 * is `<origin>/api`, as the pairing dialog builds it; the page has no
 * pairing command from the API, so there is no alternative to offer.
 */
export function installGuide(origin: string) {
  const { primary: server } = pairingServers(origin, '');
  return {
    install: [
      ...INSTALL_COMMANDS,
      { label: 'Bun', command: BUN_INSTALL_COMMAND },
    ],
    version: VERSION_COMMAND,
    server,
    pair: pairCommand(server, PAIRING_CODE_PLACEHOLDER),
    keepOnline: KEEP_ONLINE_COMMANDS,
    run: RUN_COMMAND,
    profiles: PROFILES_DETECT_COMMAND,
    claudeCode: {
      listProfiles: PROFILES_LIST_COMMAND,
      setup: SETUP_CLAUDE_COMMAND,
      dryRun: SETUP_CLAUDE_DRY_RUN_COMMAND,
      uninstall: SETUP_CLAUDE_UNINSTALL_COMMAND,
      status: RUNNER_STATUS_COMMAND,
    },
    health: `${server}/health`,
    healthCheck: `curl ${server}/health`,
    npmPrefix: NPM_PREFIX_COMMAND,
  };
}
