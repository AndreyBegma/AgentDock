import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ConfigProfile } from '../config';
import {
  FILTER_PROJECT_ENV,
  FILTER_RUN_ENV,
  FILTER_RUN_FILE,
  FILTER_RUN_KIND_ENV,
  FILTER_STATS_ENV,
  LAUNCH_SETTINGS_ENV,
  TECHNIQUES_ENV,
} from '../filter/env';
import { tempDir } from '../testing/fixtures';
import firstTurn from './fixtures/first-turn.json';
import { profileClaudeJson, profileMcpServerNames } from './profile-mcp';
import {
  AUTOCOMPACT_PCT_ENV,
  AUTOCOMPACT_WINDOW_ENV,
  autoCompactWindowFor,
  COMPACT_AT_TOKENS,
  CS_ECO_ENV,
  compactThreshold,
  EXCLUDE_DYNAMIC_SECTIONS_FLAG,
  EXPLORE_AGENT,
  filterHookSettings,
  LAUNCH_AGENTS,
  PREFIX_SETTINGS,
  PROMPT_CACHE_TTL_ENV,
  type TokenSaverLaunchInput,
  tokenSaverLaunch,
  toolCutMatcher,
} from './token-saver';

const SELF = ['/opt/nautelle/bin/nautelle-runner'];

describe('tokenSaverLaunch (#445)', () => {
  let home = '';
  let dir = '';
  let profile: ConfigProfile;
  let cleanup = () => {};

  beforeEach(() => {
    ({ dir: home, cleanup } = tempDir());
    dir = join(home, 'run');
    mkdirSync(dir);
    const config = join(home, '.claude-profiles', 'a');
    mkdirSync(config, { recursive: true });
    profile = {
      id: 'claude-a',
      runtime: 'claude',
      env: { CLAUDE_CONFIG_DIR: config },
      args: [],
    };
    writeFileSync(
      join(config, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'npx', args: ['@playwright/mcp'] },
          woodpecker: { command: 'wp', env: { WOODPECKER_TOKEN: 's3cret' } },
        },
      }),
    );
  });
  afterEach(() => cleanup());

  const input = (
    over: Partial<TokenSaverLaunchInput> = {},
  ): TokenSaverLaunchInput => ({
    config: { enabled: true, mcpAllow: [] },
    profile,
    home,
    dir,
    selfCommand: SELF,
    runKind: 'card',
    projectId: 'prj_a',
    runId: 'run-1',
    runnerMcp: [],
    scout: true,
    ...over,
  });

  const mcpOf = (file: string): Record<string, unknown> =>
    JSON.parse(readFileSync(file, 'utf8')).mcpServers;

  it('is null when the setting is absent or off — the launch stays as it was', () => {
    expect(tokenSaverLaunch(input({ config: undefined }))).toBeNull();
    expect(
      tokenSaverLaunch(
        input({ config: { enabled: false, mcpAllow: ['playwright'] } }),
      ),
    ).toBeNull();
    expect(existsSync(join(dir, 'token-saver-settings.json'))).toBe(false);
  });

  it('carries the technique flags it was given, and none by default (#746)', () => {
    expect(tokenSaverLaunch(input())?.techniques).toEqual({});
    expect(
      tokenSaverLaunch(input({ techniques: { filter: false } }))?.techniques,
    ).toEqual({ filter: false });
  });

  it('passes the settings, a strict MCP list and the agents, in that order', () => {
    const launch = tokenSaverLaunch(input({ runKind: 'skill' }));
    expect(launch).not.toBeNull();
    expect(launch?.args).toEqual([
      '--settings',
      join(dir, 'token-saver-settings.json'),
      '--strict-mcp-config',
      '--mcp-config',
      join(dir, 'token-saver-mcp.json'),
      '--agents',
      JSON.stringify(LAUNCH_AGENTS),
    ]);
    expect(LAUNCH_AGENTS.scout.model).toBe('haiku');
  });

  it('runs the built-in Explore on haiku, read-only, beside the scout (#663)', () => {
    const launch = tokenSaverLaunch(input());
    const args = launch?.args ?? [];
    const agents = JSON.parse(args[args.indexOf('--agents') + 1] ?? '{}');
    expect(Object.keys(agents)).toEqual(['scout', EXPLORE_AGENT]);
    expect(EXPLORE_AGENT).toBe('Explore');
    expect(agents.Explore.model).toBe('haiku');
    expect(agents.Explore.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('writes the prefix settings beside the hooks, for every kind (#663)', () => {
    for (const runKind of ['card', 'plan', 'skill', 'orchestrator'] as const) {
      const launch = tokenSaverLaunch(input({ runKind }));
      const settings = JSON.parse(
        readFileSync(launch?.settingsFile ?? '', 'utf8'),
      );
      expect(settings.includeGitInstructions).toBe(false);
      expect(settings.skillListingMaxDescChars).toBe(200);
      expect(Object.keys(settings.hooks)).toContain('PreToolUse');
    }
  });

  it('gives a card or CI-fix round the one-hour TTL and a prefix without dynamic sections (#663)', () => {
    const launch = tokenSaverLaunch(input({ runKind: 'card' }));
    expect(launch?.env[PROMPT_CACHE_TTL_ENV]).toBe('1h');
    expect(launch?.args.at(-1)).toBe(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
  });

  it('leaves every other kind on the default TTL and the full prefix (#663)', () => {
    for (const runKind of [
      'skill',
      'plan',
      'ui_profile',
      'card_assess',
      'card_capture',
      'text_normalize',
      'orchestrator',
    ] as const) {
      const launch = tokenSaverLaunch(input({ runKind }));
      expect(launch?.env[PROMPT_CACHE_TTL_ENV]).toBeUndefined();
      expect(launch?.args).not.toContain(EXCLUDE_DYNAMIC_SECTIONS_FLAG);
    }
  });

  it('gives an allowlist of [playwright] exactly nautelle and playwright', () => {
    const launch = tokenSaverLaunch(
      input({ config: { enabled: true, mcpAllow: ['playwright'] } }),
    );
    const servers = mcpOf(launch?.mcpFile ?? '');
    expect(Object.keys(servers).sort()).toEqual(['nautelle', 'playwright']);
    expect(servers.playwright).toEqual({
      command: 'npx',
      args: ['@playwright/mcp'],
    });
    expect(servers.nautelle).toEqual({ command: SELF[0], args: ['mcp'] });
  });

  it('gives an empty allowlist nautelle only', () => {
    const launch = tokenSaverLaunch(input());
    expect(Object.keys(mcpOf(launch?.mcpFile ?? ''))).toEqual(['nautelle']);
  });

  it('leaves nautelle out of a launch that does not use it', () => {
    const launch = tokenSaverLaunch(
      input({
        runnerMcp: false,
        config: { enabled: true, mcpAllow: ['woodpecker'] },
      }),
    );
    expect(Object.keys(mcpOf(launch?.mcpFile ?? ''))).toEqual(['woodpecker']);
  });

  it('starts nautelle with the given arguments after `mcp`', () => {
    const launch = tokenSaverLaunch(
      input({ runnerMcp: ['--finish-guard', '--issue', '7'] }),
    );
    expect(mcpOf(launch?.mcpFile ?? '').nautelle).toEqual({
      command: SELF[0],
      args: ['mcp', '--finish-guard', '--issue', '7'],
    });
  });

  it('skips and reports an allowed server the profile does not define', () => {
    const launch = tokenSaverLaunch(
      input({ config: { enabled: true, mcpAllow: ['glitchtip'] } }),
    );
    expect(launch?.missing).toEqual(['glitchtip']);
    expect(Object.keys(mcpOf(launch?.mcpFile ?? ''))).toEqual(['nautelle']);
  });

  it('writes the MCP file 0600: it may hold the copied secrets', () => {
    const launch = tokenSaverLaunch(
      input({ config: { enabled: true, mcpAllow: ['woodpecker'] } }),
    );
    expect(statSync(launch?.mcpFile ?? '').mode & 0o777).toBe(0o600);
  });

  it('sets compaction, the launch settings and the filter files in the env', () => {
    const launch = tokenSaverLaunch(input());
    expect(launch?.env).toEqual({
      [AUTOCOMPACT_WINDOW_ENV]: '183000',
      [AUTOCOMPACT_PCT_ENV]: '100',
      [PROMPT_CACHE_TTL_ENV]: '1h',
      [CS_ECO_ENV]: 'off',
      [LAUNCH_SETTINGS_ENV]: join(dir, 'token-saver-settings.json'),
      [FILTER_STATS_ENV]: join(dir, 'filter-stats.jsonl'),
      [FILTER_PROJECT_ENV]: 'prj_a',
      [FILTER_RUN_KIND_ENV]: 'card',
      [FILTER_RUN_ENV]: 'run-1',
    });
    expect(existsSync(join(dir, 'raw'))).toBe(true);
  });

  it('writes the run dir its identity, for the stats reader (DR-05)', () => {
    const launch = tokenSaverLaunch(input());
    expect(launch).not.toBeNull();
    const file = join(dir, FILTER_RUN_FILE);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      projectId: 'prj_a',
      runId: 'run-1',
      runKind: 'card',
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('sets no run id for the orchestrator session', () => {
    const launch = tokenSaverLaunch(
      input({ runKind: 'orchestrator', runId: null }),
    );
    expect(launch?.env[FILTER_RUN_ENV]).toBeUndefined();
    expect(launch?.env[FILTER_RUN_KIND_ENV]).toBe('orchestrator');
  });

  it('leaves the scout out when asked', () => {
    const launch = tokenSaverLaunch(input({ scout: false }));
    expect(launch?.args).not.toContain('--agents');
  });

  it('is null — the launch runs unfiltered — when its files cannot be written', () => {
    const notADir = join(home, 'a-file');
    writeFileSync(notADir, '');
    expect(tokenSaverLaunch(input({ dir: notADir }))).toBeNull();
  });

  it('turns the plugin’s eco hooks off: the runner guards reads (#616)', () => {
    expect(tokenSaverLaunch(input())?.env[CS_ECO_ENV]).toBe('off');
  });

  it('writes the read guard into the launch settings (#616)', () => {
    const launch = tokenSaverLaunch(input());
    const settings = JSON.parse(
      readFileSync(launch?.settingsFile ?? '', 'utf8'),
    );
    const read = `${SELF[0]} read-hook || true`;
    expect(settings.hooks.PreToolUse[1].matcher).toBe('Read');
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toBe(read);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(read);
  });

  describe('technique flags (#747 D3, D4)', () => {
    const launched = (techniques?: TokenSaverLaunchInput['techniques']) => {
      const launch = tokenSaverLaunch(input({ techniques }));
      return {
        env: launch?.env,
        settings: readFileSync(launch?.settingsFile ?? '', 'utf8'),
      };
    };

    it('without flags, writes the same settings and env as with none on', () => {
      const before = launched();
      expect(before.env?.[TECHNIQUES_ENV]).toBeUndefined();
      expect(before.settings).not.toContain('tool-hook');
      for (const off of [
        {},
        { 'mcp-cut': false, 'grep-cut': false, 'webfetch-cut': false },
      ]) {
        const after = launched(off);
        expect(after.env).toEqual(before.env);
        expect(after.settings).toBe(before.settings);
      }
    });

    it('runs tool-hook after the cut tools and names the keys that are on', () => {
      const { env, settings } = launched({
        'mcp-cut': true,
        'grep-cut': true,
        'webfetch-cut': true,
      });
      expect(env?.[TECHNIQUES_ENV]).toBe('mcp-cut,grep-cut,webfetch-cut');
      expect(JSON.parse(settings).hooks.PostToolUse).toContainEqual({
        matcher: 'mcp__.*|Grep|WebFetch',
        hooks: [
          {
            type: 'command',
            command: `${SELF[0]} tool-hook || true`,
            timeout: 10,
          },
        ],
      });
    });

    it('leaves a cut that is off out of the matcher', () => {
      const { env, settings } = launched({
        'mcp-cut': true,
        'grep-cut': false,
        'webfetch-cut': true,
      });
      expect(env?.[TECHNIQUES_ENV]).toBe('mcp-cut,webfetch-cut');
      const matchers = JSON.parse(settings).hooks.PostToolUse.map(
        (entry: { matcher?: string }) => entry.matcher,
      );
      expect(matchers).toEqual(['Read', 'mcp__.*|WebFetch']);
    });

    it('adds no tool-hook for the techniques that are not cuts', () => {
      const { env, settings } = launched({
        'read-guard-400': true,
        'terse-register': true,
      });
      expect(env?.[TECHNIQUES_ENV]).toBe('read-guard-400,terse-register');
      expect(settings).not.toContain('tool-hook');
    });
  });

  describe('early compaction (amendment 12)', () => {
    const env = (): Record<string, string> =>
      tokenSaverLaunch(input())?.env ?? {};

    // [model, context window, max output tokens].
    const models: [string, number, number][] = [
      ['opus (1M)', 1_000_000, 128_000],
      ['sonnet (1M)', 1_000_000, 64_000],
      ['opus (200k)', 200_000, 32_000],
      ['sonnet (200k)', 200_000, 64_000],
      ['haiku', 200_000, 64_000],
    ];

    for (const [model, window, output] of models) {
      it(`compacts ${model} at ${COMPACT_AT_TOKENS} tokens`, () => {
        expect(compactThreshold(window, output, env())).toBe(COMPACT_AT_TOKENS);
      });
    }

    it('was about 600k on a 1M window with the old 60 %', () => {
      expect(
        compactThreshold(1_000_000, 128_000, { [AUTOCOMPACT_PCT_ENV]: '60' }),
      ).toBe(588_000);
    });

    it('wins over a percentage the profile carries', () => {
      const launched = { [AUTOCOMPACT_PCT_ENV]: '40', ...env() };
      expect(compactThreshold(1_000_000, 128_000, launched)).toBe(
        COMPACT_AT_TOKENS,
      );
    });

    it('never asks for a window under Claude Code’s 100k floor', () => {
      expect(autoCompactWindowFor(10_000)).toBe(100_000);
      expect(autoCompactWindowFor(COMPACT_AT_TOKENS)).toBe(183_000);
    });
  });
});

/**
 * #663 acceptance: the first turn of a card, design or Planner launch is 25k
 * tokens or less. Measured, not assumed: a wrongly named flag does nothing
 * silently (ADR-0068), so the figure comes from a recorded turn, and the
 * recording is tied to the settings it was made with.
 */
describe('first-turn prefix (#663)', () => {
  const PREFIX_BUDGET = 25_000;
  const total = (usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }): number =>
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens;

  it('was recorded with the prefix settings the launch writes today', () => {
    expect(firstTurn.settings).toEqual({ ...PREFIX_SETTINGS });
  });

  it.each([
    ['card and CI-fix', firstTurn.turns.card.usage],
    ['Planner and design', firstTurn.turns.plan.usage],
  ])('keeps the %s first turn at 25k tokens or less', (_, usage) => {
    expect(total(usage)).toBeLessThanOrEqual(PREFIX_BUDGET);
  });

  it('is smaller than the launch without the prefix settings', () => {
    expect(total(firstTurn.turns.card.usage)).toBeLessThan(
      total(firstTurn.baseline.usage),
    );
  });
});

describe('filterHookSettings (#445 D3)', () => {
  it('rewrites Bash through `filter-hook` and guards Read, failing open', () => {
    const hook = (subcommand: string) => [
      {
        type: 'command' as const,
        command: `/usr/bin/bun '/my dir/cli.ts' ${subcommand} || true`,
        timeout: 10,
      },
    ];
    expect(filterHookSettings(['/usr/bin/bun', '/my dir/cli.ts'])).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: hook('filter-hook') },
          { matcher: 'Read', hooks: hook('read-hook') },
        ],
        PostToolUse: [{ matcher: 'Read', hooks: hook('read-hook') }],
        PreCompact: [{ hooks: hook('read-hook') }],
      },
    });
  });

  it('keeps the hooks it is given', () => {
    const base = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command' as const, command: 'x stop' }] }],
      },
    };
    const settings = filterHookSettings(SELF, base);
    expect(settings.hooks.Stop).toEqual(base.hooks.Stop);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('Bash');
  });
});

describe('toolCutMatcher (#747 D4)', () => {
  it('is built from the cut techniques that are on, in a fixed order', () => {
    expect(toolCutMatcher(undefined)).toBeNull();
    expect(toolCutMatcher({ 'read-guard-400': true })).toBeNull();
    expect(toolCutMatcher({ 'webfetch-cut': true, 'mcp-cut': true })).toBe(
      'mcp__.*|WebFetch',
    );
    expect(toolCutMatcher({ 'grep-cut': true })).toBe('Grep');
  });
});

describe('profile MCP servers (#445 Amendment 2)', () => {
  it('reads `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`', () => {
    const base = { id: 'p', runtime: 'claude' as const, args: [] };
    expect(
      profileClaudeJson(
        { ...base, env: { CLAUDE_CONFIG_DIR: '~/.claude-profiles/x' } },
        '/home/u',
      ),
    ).toBe('/home/u/.claude-profiles/x/.claude.json');
    expect(profileClaudeJson({ ...base, env: {} }, '/home/u')).toBe(
      '/home/u/.claude.json',
    );
  });

  it('is none for a missing or malformed file', () => {
    const { dir, cleanup } = tempDir();
    try {
      const profile: ConfigProfile = {
        id: 'p',
        runtime: 'claude',
        env: { CLAUDE_CONFIG_DIR: dir },
        args: [],
      };
      expect(profileMcpServerNames(profile, dir)).toEqual([]);
      writeFileSync(join(dir, '.claude.json'), '{"mcpServers": 3}');
      expect(profileMcpServerNames(profile, dir)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
