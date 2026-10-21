import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isRunnerMcpServer,
  RUNNER_MCP_SERVER,
  type TechniqueFlags,
  type TokenSaverConfig,
  type TokenSaverRunKind,
} from '@nautelle/shared';
import type { ConfigProfile } from '../config';
import {
  FILTER_RAW_DIR,
  FILTER_RUN_FILE,
  FILTER_STATS_FILE,
  type FilterLaunch,
  filterEnv,
  LAUNCH_SETTINGS_ENV,
  TECHNIQUE_CACHE_TTL_1H,
  TECHNIQUE_GREP_CUT,
  TECHNIQUE_MCP_CUT,
  TECHNIQUE_WEBFETCH_CUT,
  techniquesEnv,
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
 * The code-sentinel plugin's `/cs-eco` switch. Amendment 12 turned it on;
 * #616 turns it off: the runner guards reads itself (`read-hook`), whether or
 * not the plugin is in the profile, and the plugin's hooks would refuse the
 * same read a second time. `off` rather than unset, so a machine default of
 * `on` cannot bring them back.
 */
export const CS_ECO_ENV = 'CS_ECO';

/** The scout subagent's name, as the worker prompt names it (D9). */
export const SCOUT_AGENT = 'scout';

/**
 * #663: Claude Code's built-in explorer. Its own definition is
 * `model: 'inherit'` — an opus session explores on opus.
 */
export const EXPLORE_AGENT = 'Explore';

/**
 * D9: the haiku scout; #663 (ADR-0068): the built-in `Explore` on haiku.
 * Claude Code 2.1.301 defines subagents on `--agents <json>`, not in a
 * settings file, and 2.1.303 lets an `--agents` entry replace a built-in of
 * the same name. Read-only tools: they search and read, they never decide or
 * edit.
 */
export const LAUNCH_AGENTS = {
  [SCOUT_AGENT]: {
    description:
      'Fast, cheap, read-only search. Use it for broad codebase searches and for reading many files to answer one question; it returns what it found with file paths and line numbers. It never edits and never decides.',
    prompt:
      'You search and read a codebase for the session that called you. Answer its question with the facts it needs: file paths, line numbers, the few lines that matter, and what you could not find. Quote, do not paraphrase code. Never edit a file, never run a command that changes anything, never give an opinion on what to do.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
  },
  [EXPLORE_AGENT]: {
    description:
      'Read-only search agent for broad fan-out searches: when answering means sweeping many files, directories or naming conventions and you only need the conclusion. Say how thorough to be: quick, medium or very thorough.',
    prompt:
      'You explore a codebase for the session that called you. Find what it asked for and report the conclusion with file paths and line numbers, quoting only the lines that matter. Read excerpts rather than whole files. You are read-only: never edit, create or delete a file, and never run a command that changes anything.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
  },
} as const;

/**
 * #663 (ADR-0068 §1): the settings that shrink a launch's fixed prefix,
 * checked against Claude Code 2.1.303 and measured on a recorded first turn
 * (`fixtures/first-turn.json`): without the built-in commit and pull request
 * instructions (about 0.7k tokens; the worker prompt and the project rules
 * carry the git workflow), and with each skill's description in the listing
 * cut to its first 200 characters (about 4.4k). `disableBundledSkills` was
 * measured too and grew the prefix, so it is not set. Deferred MCP tools need
 * no setting: an unset `ENABLE_TOOL_SEARCH` already defers them on a
 * first-party host, and any explicit value would also force them through a
 * proxy that may not forward tool references.
 */
export const PREFIX_SETTINGS = {
  includeGitInstructions: false,
  skillListingMaxDescChars: 200,
} as const;

/**
 * #663 (ADR-0068 §1): Claude Code's prompt-cache TTL for the main
 * conversation, `5m` or `1h`; it wins over `ENABLE_PROMPT_CACHING_1H`.
 */
export const PROMPT_CACHE_TTL_ENV = 'CLAUDE_CODE_PROMPT_CACHE_TTL';

/**
 * #663: moves the per-machine sections (cwd, env, memory paths, git status)
 * out of the system prompt into the first user message, so the prefix is the
 * same across rounds and runners.
 */
export const EXCLUDE_DYNAMIC_SECTIONS_FLAG =
  '--exclude-dynamic-system-prompt-sections';

/**
 * #663 (ADR-0068 §1): the kinds whose prefix is reused across rounds — card
 * and CI-fix rounds, both `card` — and so pay for the one-hour TTL (a write
 * costs 2× the input price against 1.25×) and a prefix without dynamic
 * sections.
 */
export const SHARED_PREFIX_KINDS: readonly TokenSaverRunKind[] = ['card'];

/**
 * #749 (technique `cache-ttl-1h`): the TTL of a card round. A key that is
 * absent or true keeps the one-hour TTL of #663; false is the control arm,
 * which pins `5m` — an unset TTL becomes 1h on a subscription.
 */
export const cacheTtlFor = (
  techniques: Partial<TechniqueFlags> | undefined,
): '1h' | '5m' =>
  techniques?.[TECHNIQUE_CACHE_TTL_1H] === false ? '5m' : '1h';

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
 * neither `nautelle` nor the scout could be called: only the strict MCP
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
    runnerMcp: false,
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
 * #747 D4: the tools each cut technique governs, as matcher alternatives, in
 * matcher order.
 */
export const TOOL_CUT_MATCHERS: readonly (readonly [string, string])[] = [
  [TECHNIQUE_MCP_CUT, 'mcp__.*'],
  [TECHNIQUE_GREP_CUT, 'Grep'],
  [TECHNIQUE_WEBFETCH_CUT, 'WebFetch'],
];

/**
 * #747 D4: the PostToolUse matcher of `tool-hook`, built only from the cut
 * techniques that are on — a technique that is off spawns no process.
 * `null` when none is on.
 */
export const toolCutMatcher = (
  techniques: Partial<TechniqueFlags> | undefined,
): string | null => {
  const on = TOOL_CUT_MATCHERS.filter(
    ([key]) => techniques?.[key] === true,
  ).map(([, matcher]) => matcher);
  return on.length === 0 ? null : on.join('|');
};

/**
 * D3: the PreToolUse hook that rewrites a Bash call into
 * `nautelle-runner filter -- <argv…>`, by the runner's absolute argv; and
 * #616's `read-hook` on `Read` (before and after) and on compaction, which
 * guards whole reads of big files and repeated reads; and #747's `tool-hook`
 * after the MCP, Grep and WebFetch calls whose cut technique is on.
 * `|| true`: the hooks fail open — an exit code 2 would block the tool.
 */
export const filterHookSettings = (
  selfCommand: readonly string[],
  base?: LaunchSettings,
  techniques?: Partial<TechniqueFlags>,
): LaunchSettings => {
  const self = selfCommand.map(shellQuote).join(' ');
  const hook = (subcommand: string): LaunchHookCommand => ({
    type: 'command',
    command: `${self} ${subcommand} || true`,
    timeout: 10,
  });
  const hooks = { ...(base?.hooks ?? {}) };
  hooks.PreToolUse = [
    ...(hooks.PreToolUse ?? []),
    { matcher: 'Bash', hooks: [hook('filter-hook')] },
    { matcher: 'Read', hooks: [hook('read-hook')] },
  ];
  hooks.PostToolUse = [
    ...(hooks.PostToolUse ?? []),
    { matcher: 'Read', hooks: [hook('read-hook')] },
  ];
  const toolCut = toolCutMatcher(techniques);
  if (toolCut !== null) {
    hooks.PostToolUse.push({ matcher: toolCut, hooks: [hook('tool-hook')] });
  }
  hooks.PreCompact = [
    ...(hooks.PreCompact ?? []),
    { hooks: [hook('read-hook')] },
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
   * The runner's own `nautelle` server: `false` for a launch that does not use it, else
   * the arguments after `mcp` (the card's artifact guard).
   */
  runnerMcp: false | readonly string[];
  /**
   * D9: whether the launch gets the scout, and with it the haiku `Explore`
   * (#663); a launch without tools can call neither.
   */
  scout: boolean;
  /** Hooks the launch already carries (the card's injected wiring). */
  baseSettings?: LaunchSettings;
  /**
   * #746 D11: the card's technique flags, `{ [technique]: on }`. #747 D3: a
   * key that is absent behaves as before its technique — no cut, the
   * 1,500-line read guard — so a launch without flags is unchanged. The cut
   * keys add `tool-hook` (D4); every key that is on reaches the hooks in
   * `NAUTELLE_TECHNIQUES`.
   */
  techniques?: Partial<TechniqueFlags>;
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
  /** #746: the technique flags this launch ran with. */
  techniques: Partial<TechniqueFlags>;
}

/**
 * #445: the one launch-wiring helper of all eight launches. `null` when
 * Token saver is off or absent — the caller launches exactly as before — and
 * when a file cannot be written: the launch then runs unfiltered rather than
 * not at all.
 *
 * On: `--settings` (the filter hook and the prefix settings of #663),
 * `--strict-mcp-config` with `nautelle` (where the launch uses it) and the
 * allowed servers copied from the profile's own config (D6), the scout and
 * the haiku `Explore` on `--agents` (D9, #663), and the env for compaction
 * (D10), the plugin's eco hooks off (#616) and the filter's stats and raw
 * files. A card or CI-fix round also gets the one-hour cache TTL and a
 * prefix without dynamic sections (#663).
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
  if (input.runnerMcp !== false) {
    servers[RUNNER_MCP_SERVER] = {
      command,
      args: [...rest, 'mcp', ...input.runnerMcp],
    };
  }
  const missing: string[] = [];
  for (const name of config.mcpAllow) {
    // ADR-0073: an allowlist from before the rename names `agentdock`.
    if (isRunnerMcpServer(name) && input.runnerMcp !== false) continue;
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
    writeJsonAtomic(settingsFile, {
      ...PREFIX_SETTINGS,
      ...filterHookSettings(
        input.selfCommand,
        input.baseSettings,
        input.techniques,
      ),
    });
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

  const sharedPrefix = SHARED_PREFIX_KINDS.includes(input.runKind);
  return {
    args: [
      '--settings',
      settingsFile,
      '--strict-mcp-config',
      '--mcp-config',
      mcpFile,
      ...(input.scout ? ['--agents', JSON.stringify(LAUNCH_AGENTS)] : []),
      ...(sharedPrefix ? [EXCLUDE_DYNAMIC_SECTIONS_FLAG] : []),
    ],
    env: {
      [AUTOCOMPACT_WINDOW_ENV]: String(autoCompactWindowFor(COMPACT_AT_TOKENS)),
      [AUTOCOMPACT_PCT_ENV]: '100',
      ...(sharedPrefix
        ? { [PROMPT_CACHE_TTL_ENV]: cacheTtlFor(input.techniques) }
        : {}),
      [CS_ECO_ENV]: 'off',
      [LAUNCH_SETTINGS_ENV]: settingsFile,
      ...filterEnv(run),
      ...techniquesEnv(input.techniques),
    },
    settingsFile,
    mcpFile,
    missing,
    techniques: input.techniques ?? {},
  };
};
