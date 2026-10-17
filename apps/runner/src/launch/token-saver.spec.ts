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
} from '../filter/env';
import { tempDir } from '../testing/fixtures';
import { profileClaudeJson, profileMcpServerNames } from './profile-mcp';
import {
  AUTOCOMPACT_PCT_ENV,
  AUTOCOMPACT_WINDOW_ENV,
  autoCompactWindowFor,
  COMPACT_AT_TOKENS,
  CS_ECO_ENV,
  compactThreshold,
  filterHookSettings,
  SCOUT_AGENTS,
  type TokenSaverLaunchInput,
  tokenSaverLaunch,
} from './token-saver';

const SELF = ['/opt/agentdock/bin/agentdock-runner'];

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
    agentdock: [],
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

  it('passes the settings, a strict MCP list and the scout, in that order', () => {
    const launch = tokenSaverLaunch(input());
    expect(launch).not.toBeNull();
    expect(launch?.args).toEqual([
      '--settings',
      join(dir, 'token-saver-settings.json'),
      '--strict-mcp-config',
      '--mcp-config',
      join(dir, 'token-saver-mcp.json'),
      '--agents',
      JSON.stringify(SCOUT_AGENTS),
    ]);
    expect(SCOUT_AGENTS.scout.model).toBe('haiku');
  });

  it('gives an allowlist of [playwright] exactly agentdock and playwright', () => {
    const launch = tokenSaverLaunch(
      input({ config: { enabled: true, mcpAllow: ['playwright'] } }),
    );
    const servers = mcpOf(launch?.mcpFile ?? '');
    expect(Object.keys(servers).sort()).toEqual(['agentdock', 'playwright']);
    expect(servers.playwright).toEqual({
      command: 'npx',
      args: ['@playwright/mcp'],
    });
    expect(servers.agentdock).toEqual({ command: SELF[0], args: ['mcp'] });
  });

  it('gives an empty allowlist agentdock only', () => {
    const launch = tokenSaverLaunch(input());
    expect(Object.keys(mcpOf(launch?.mcpFile ?? ''))).toEqual(['agentdock']);
  });

  it('leaves agentdock out of a launch that does not use it', () => {
    const launch = tokenSaverLaunch(
      input({
        agentdock: false,
        config: { enabled: true, mcpAllow: ['woodpecker'] },
      }),
    );
    expect(Object.keys(mcpOf(launch?.mcpFile ?? ''))).toEqual(['woodpecker']);
  });

  it('starts agentdock with the given arguments after `mcp`', () => {
    const launch = tokenSaverLaunch(
      input({ agentdock: ['--finish-guard', '--issue', '7'] }),
    );
    expect(mcpOf(launch?.mcpFile ?? '').agentdock).toEqual({
      command: SELF[0],
      args: ['mcp', '--finish-guard', '--issue', '7'],
    });
  });

  it('skips and reports an allowed server the profile does not define', () => {
    const launch = tokenSaverLaunch(
      input({ config: { enabled: true, mcpAllow: ['glitchtip'] } }),
    );
    expect(launch?.missing).toEqual(['glitchtip']);
    expect(Object.keys(mcpOf(launch?.mcpFile ?? ''))).toEqual(['agentdock']);
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
      [CS_ECO_ENV]: 'on',
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

  it('turns the plugin’s eco hooks on (amendment 12)', () => {
    expect(tokenSaverLaunch(input())?.env[CS_ECO_ENV]).toBe('on');
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

describe('filterHookSettings (#445 D3)', () => {
  it('rewrites Bash through `filter-hook`, failing open', () => {
    expect(filterHookSettings(['/usr/bin/bun', '/my dir/cli.ts'])).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: "/usr/bin/bun '/my dir/cli.ts' filter-hook || true",
                timeout: 10,
              },
            ],
          },
        ],
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
