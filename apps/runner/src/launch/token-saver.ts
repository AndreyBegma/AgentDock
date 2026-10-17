import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TokenSaverConfig, TokenSaverRunKind } from '@agentdock/shared';
import type { ConfigProfile } from '../config';
import {
  FILTER_RAW_DIR,
  FILTER_RUN_FILE,
  FILTER_STATS_FILE,
  type FilterLaunch,
  filterEnv,
  LAUNCH_SETTINGS_ENV,
} from '../filter/env';
import { writeJsonAtomic } from '../skills/run/record';
import { readProfileMcpServers } from './profile-mcp';

/** #445: the launch's own files, in its run dir. */
export const TOKEN_SAVER_FILES = {
  settings: 'token-saver-settings.json',
  mcp: 'token-saver-mcp.json',
  stats: FILTER_STATS_FILE,
  run: FILTER_RUN_FILE,
  raw: FILTER_RAW_DIR,
} as const;

/** The MCP server's name — the plugin's, so `finish_card` reads the same. */
export const AGENTDOCK_MCP_SERVER = 'agentdock';

/**
 * D10, amendment 12: the context size, in tokens, at which a Token saver
 * session compacts — on every model, whatever its window.
 */
export const COMPACT_AT_TOKENS = 150_000;

/**
 * Amendment 12: Claude Code's absolute compaction window, in tokens. Checked
 * against Claude Code 2.1.302: the window is `min(model window, max(100k,
 * value))`, and it compacts at that window less the output reserve
 * (`min(maxOutputTokens, 20000)`) less a 13000-token summary buffer.
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is a share of that same window — on a 1M
 * window 60 % was about 600k — and lowers the threshold further, so the
 * launch pins it to 100 (no effect) over any value a profile carries.
 */
export const AUTOCOMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const AUTOCOMPACT_PCT_ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const COMPACT_OUTPUT_RESERVE = 20_000;
const COMPACT_SUMMARY_BUFFER = 13_000;
const COMPACT_WINDOW_FLOOR = 100_000;

/** The window that makes Claude Code compact at `threshold` tokens. */
export const autoCompactWindowFor = (threshold: number): number =>
  Math.max(
    COMPACT_WINDOW_FLOOR,
    threshold + COMPACT_OUTPUT_RESERVE + COMPACT_SUMMARY_BUFFER,
  );

/**
 * Where Claude Code 2.1.302 compacts a model with `modelWindow` tokens and
 * `maxOutputTokens`, given the launch env — its formula, for the tests.
 */
export const compactThreshold = (
  modelWindow: number,
  maxOutputTokens: number,
  env: Readonly<Record<string, string>>,
): number => {
  const configured = Number(env[AUTOCOMPACT_WINDOW_ENV]);
  const window = Number.isFinite(configured)
    ? Math.min(modelWindow, Math.max(COMPACT_WINDOW_FLOOR, configured))
    : modelWindow;
  const effective = window - Math.min(maxOutputTokens, COMPACT_OUTPUT_RESERVE);
  const ceiling = effective - COMPACT_SUMMARY_BUFFER;
  const pct = Number(env[AUTOCOMPACT_PCT_ENV]);
  return pct > 0 && pct <= 100
    ? Math.min(Math.floor(effective * (pct / 100)), ceiling)
    : ceiling;
};

/**
 * Amendment 12: the code-sentinel plugin's `/cs-eco` switch. Its hooks then
 * guard whole reads, drop repeated ones and cut large MCP results; its Bash
 * hook stands down, since `AGENTDOCK_FILTER_STATS` says the runner filters.
 */
export const CS_ECO_ENV = 'CS_ECO';

/** The scout subagent's name, as the worker prompt names it (D9). */
export const SCOUT_AGENT = 'scout';

/**
 * D9: the haiku scout. Claude Code 2.1.301 defines subagents on
 * `--agents <json>`, not in a settings file. Read-only tools: it searches
 * and reads, it never decides or edits.
 */
export const SCOUT_AGENTS = {
  [SCOUT_AGENT]: {
    description:
      'Fast, cheap, read-only search. Use it for broad codebase searches and for reading many files to answer one question; it returns what it found with file paths and line numbers. It never edits and never decides.',
    prompt:
      'You search and read a codebase for the session that called you. Answer its question with the facts it needs: file paths, line numbers, the few lines that matter, and what you could not find. Quote, do not paraphrase code. Never edit a file, never run a command that changes anything, never give an opinion on what to do.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
  },
} as const;

/** One argument for `sh -c`: bare when it is safe, else single-quoted. */
export const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, `'\\''`)}'`;

/**
 * The argv that starts this runner when nobody passes one: the compiled
 * binary alone, or Bun and the script (the daemon's own rule).
 */
export const defaultSelfCommand = (): string[] =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, Bun.main];

/**
 * #445: what a headless text call (assessment, capture, normalization)
 * needs to wire Token saver; the daemon may leave both out.
 */
export interface TextCallLaunchOptions {
  home?: string;
  selfCommand?: readonly string[];
}

/**
 * #445: a headless text call's Token saver. These run `--tools ""`, so
 * neither `agentdock` nor the scout could be called: only the strict MCP
 * list (the allowlist), the hook and compaction. `null` when off.
 */
export const textCallTokenSaver = (
  options: TextCallLaunchOptions,
  profile: ConfigProfile,
  args: { tokenSaver?: TokenSaverConfig; runId: string; projectId: string },
  dir: string,
  runKind: TokenSaverRunKind,
): TokenSaverLaunch | null =>
  tokenSaverLaunch({
    config: args.tokenSaver,
    profile,
    home: options.home ?? homedir(),
    dir,
    selfCommand: options.selfCommand ?? defaultSelfCommand(),
    runKind,
    projectId: args.projectId,
    runId: args.runId,
    agentdock: false,
    scout: false,
  });

export interface LaunchHookCommand {
  type: 'command';
  command: string;
  timeout?: number;
  async?: true;
}

export interface LaunchSettings {
  hooks: Record<string, { matcher?: string; hooks: LaunchHookCommand[] }[]>;
}

/**
 * D3: the PreToolUse hook that rewrites a Bash call into
 * `agentdock-runner filter -- <argv…>`, by the runner's absolute argv.
 * `|| true`: the hook fails open — an exit code 2 would block the tool.
 */
export const filterHookSettings = (
  selfCommand: readonly string[],
  base?: LaunchSettings,
): LaunchSettings => {
  const self = selfCommand.map(shellQuote).join(' ');
  const hooks = { ...(base?.hooks ?? {}) };
  hooks.PreToolUse = [
    ...(hooks.PreToolUse ?? []),
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: `${self} filter-hook || true`,
          timeout: 10,
        },
      ],
    },
  ];
  return { hooks };
};

export interface TokenSaverLaunchInput {
  /** The launch command's `tokenSaver`; absent is off. */
  config: TokenSaverConfig | undefined;
  profile: ConfigProfile;
  home: string;
  /** The launch's run dir; it exists. */
  dir: string;
  selfCommand: readonly string[];
  runKind: TokenSaverRunKind;
  /** The project the launch runs for: the stats rows' envelope. */
  projectId: string;
  /** `null` for the orchestrator session only. */
  runId: string | null;
  /**
   * The `agentdock` server: `false` for a launch that does not use it, else
   * the arguments after `mcp` (the card's artifact guard).
   */
  agentdock: false | readonly string[];
  /** D9: whether the launch gets the scout; a launch without tools does not. */
  scout: boolean;
  /** Hooks the launch already carries (the card's injected wiring). */
  baseSettings?: LaunchSettings;
}

export interface TokenSaverLaunch {
  /** After the profile's args and the session flags, before `--model`. */
  args: string[];
  /** Over the launch's own env. */
  env: Record<string, string>;
  settingsFile: string;
  mcpFile: string;
  /** Allowed servers the profile does not define — left out. */
  missing: string[];
}

/**
 * #445: the one launch-wiring helper of all eight launches. `null` when
 * Token saver is off or absent — the caller launches exactly as before — and
 * when a file cannot be written: the launch then runs unfiltered rather than
 * not at all.
 *
 * On: `--settings` (the filter hook), `--strict-mcp-config` with
 * `agentdock` (where the launch uses it) and the allowed servers copied
 * from the profile's own config (D6), the scout on `--agents` (D9), and the
 * env for compaction (D10), the plugin's eco hooks (amendment 12) and the
 * filter's stats and raw files.
 */
export const tokenSaverLaunch = (
  input: TokenSaverLaunchInput,
): TokenSaverLaunch | null => {
  const { config } = input;
  if (!config?.enabled) return null;
  const [command, ...rest] = input.selfCommand;
  if (command === undefined) return null;

  const defined = readProfileMcpServers(input.profile, input.home);
  const servers: Record<string, unknown> = {};
  if (input.agentdock !== false) {
    servers[AGENTDOCK_MCP_SERVER] = {
      command,
      args: [...rest, 'mcp', ...input.agentdock],
    };
  }
  const missing: string[] = [];
  for (const name of config.mcpAllow) {
    if (name === AGENTDOCK_MCP_SERVER && input.agentdock !== false) continue;
    const definition = defined[name];
    if (definition === undefined) missing.push(name);
    else servers[name] = definition;
  }

  const settingsFile = join(input.dir, TOKEN_SAVER_FILES.settings);
  const mcpFile = join(input.dir, TOKEN_SAVER_FILES.mcp);
  const rawDir = join(input.dir, TOKEN_SAVER_FILES.raw);
  const run: FilterLaunch = {
    runDir: input.dir,
    projectId: input.projectId,
    runId: input.runId,
    runKind: input.runKind,
  };
  try {
    mkdirSync(rawDir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(
      settingsFile,
      filterHookSettings(input.selfCommand, input.baseSettings),
    );
    // 0600 (writeJsonAtomic): the copied definitions may hold secrets.
    writeJsonAtomic(mcpFile, { mcpServers: servers });
    // DR-05: the stats reader's identity for this dir — not the rows'.
    writeJsonAtomic(join(input.dir, TOKEN_SAVER_FILES.run), {
      projectId: run.projectId,
      runId: run.runId,
      runKind: run.runKind,
    });
  } catch {
    return null;
  }

  return {
    args: [
      '--settings',
      settingsFile,
      '--strict-mcp-config',
      '--mcp-config',
      mcpFile,
      ...(input.scout ? ['--agents', JSON.stringify(SCOUT_AGENTS)] : []),
    ],
    env: {
      [AUTOCOMPACT_WINDOW_ENV]: String(autoCompactWindowFor(COMPACT_AT_TOKENS)),
      [AUTOCOMPACT_PCT_ENV]: '100',
      [CS_ECO_ENV]: 'on',
      [LAUNCH_SETTINGS_ENV]: settingsFile,
      ...filterEnv(run),
    },
    settingsFile,
    mcpFile,
    missing,
  };
};
