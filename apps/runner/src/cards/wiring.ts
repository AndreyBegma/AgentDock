import { join } from 'node:path';
import { RUNNER_MCP_SERVER } from '@nautelle/shared';
import type {
  CardRunWiring,
  CardRunWiringReason,
} from '@nautelle/shared/protocol';
import type { ConfigProfile } from '../config';
import { readProfileAgentdock } from '../detect/capabilities';
import { claudeConfigDir } from '../detect/profiles';
import { shellQuote } from '../launch/token-saver';
import { writeJsonAtomic } from '../skills/run/record';

/** #367 D1: the round's files, beside `run.json`. */
export const CARD_WIRING_FILES = {
  settings: 'nautelle-settings.json',
  mcp: 'nautelle-mcp.json',
} as const;

/** The MCP server's name — the plugin's, so `finish_card` reads the same. */
export const CARD_MCP_SERVER = RUNNER_MCP_SERVER;

interface HookEntry {
  event: string;
  subcommand: string;
  timeout?: number;
  async?: true;
}

/**
 * The hooks of `plugins/nautelle/hooks/hooks.json`, in its order and with
 * its options (`wiring.spec.ts` holds the two together).
 */
const HOOKS: readonly HookEntry[] = [
  { event: 'SessionStart', subcommand: 'session-start', timeout: 10 },
  {
    event: 'PermissionRequest',
    subcommand: 'permission-request',
    timeout: 300,
  },
  { event: 'UserPromptSubmit', subcommand: 'user-prompt-submit', async: true },
  { event: 'PostToolUse', subcommand: 'post-tool-use', async: true },
  {
    event: 'PostToolUseFailure',
    subcommand: 'post-tool-use-failure',
    async: true,
  },
  { event: 'Notification', subcommand: 'notification', async: true },
  { event: 'Stop', subcommand: 'stop', async: true },
  { event: 'PreCompact', subcommand: 'pre-compact', async: true },
  { event: 'SessionEnd', subcommand: 'session-end', async: true },
];

export interface CardHookCommand {
  type: 'command';
  command: string;
  timeout?: number;
  async?: true;
}

export interface CardHooksSettings {
  hooks: Record<string, { hooks: CardHookCommand[] }[]>;
}

/**
 * D1: the plugin's hooks, each calling this runner by its absolute argv
 * instead of `nautelle-runner` on `PATH`. `|| true`: a hook never fails the
 * session, as in the plugin.
 */
export const cardHooksSettings = (
  selfCommand: readonly string[],
): CardHooksSettings => {
  const self = selfCommand.map(shellQuote).join(' ');
  return {
    hooks: Object.fromEntries(
      HOOKS.map(({ event, subcommand, timeout, async }) => [
        event,
        [
          {
            hooks: [
              {
                type: 'command' as const,
                command: `${self} hook ${subcommand} || true`,
                ...(timeout === undefined ? {} : { timeout }),
                ...(async ? { async } : {}),
              },
            ],
          },
        ],
      ]),
    ),
  };
};

/** D1: the plugin's MCP server (`nautelle-runner mcp`), by absolute argv. */
export const cardMcpConfig = (selfCommand: readonly string[]) => {
  const [command, ...rest] = selfCommand;
  if (command === undefined) throw new Error('the runner has no argv');
  return {
    mcpServers: {
      [CARD_MCP_SERVER]: { command, args: [...rest, 'mcp'] },
    },
  };
};

/** The files `cardArgv` passes as `--settings` / `--mcp-config`. */
export interface CardWiringFiles {
  settings: string;
  mcp: string;
}

/** D3: what a round's `running` event says about its wiring. */
export interface CardWiring {
  wiring: CardRunWiring;
  wiringReason?: CardRunWiringReason;
  /** With `injected` only. */
  files?: CardWiringFiles;
}

/**
 * D1, D2: a profile whose plugin report names the nautelle plugin gets
 * nothing (it would fire every hook twice); any other gets the round's two
 * files. A write that fails leaves the round unwired, with the reason —
 * it still starts.
 */
export const wireCardRound = (
  profile: ConfigProfile,
  home: string,
  roundDir: string,
  selfCommand: readonly string[],
): CardWiring => {
  if (readProfileAgentdock(claudeConfigDir(profile, home), null).plugin) {
    return { wiring: 'plugin' };
  }
  const files: CardWiringFiles = {
    settings: join(roundDir, CARD_WIRING_FILES.settings),
    mcp: join(roundDir, CARD_WIRING_FILES.mcp),
  };
  try {
    writeJsonAtomic(files.settings, cardHooksSettings(selfCommand));
    writeJsonAtomic(files.mcp, cardMcpConfig(selfCommand));
  } catch {
    return { wiring: 'none', wiringReason: 'settings_write_failed' };
  }
  return { wiring: 'injected', files };
};
