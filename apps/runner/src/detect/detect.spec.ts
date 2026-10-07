import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilitiesSchema } from '@agentdock/shared/protocol';
import { fakeExec, machineWithoutCodex, tempDir } from '../testing/fixtures';
import {
  detectCapabilities,
  extractVersion,
  parseGhUser,
  readCodeSentinel,
} from './capabilities';
import { createExec } from './exec';
import {
  detectProfiles,
  isAuthenticated,
  withAuthentication,
} from './profiles';

describe('profile detection', () => {
  let home = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir: home, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('proposes the default and one claude profile per ~/.claude-profiles dir, with auth flags', () => {
    mkdirSync(join(home, '.claude-profiles', 'a'), { recursive: true });
    mkdirSync(join(home, '.claude-profiles', 'b'), { recursive: true });
    writeFileSync(
      join(home, '.claude-profiles', 'a', '.credentials.json'),
      '{"x":1}',
    );
    writeFileSync(join(home, '.claude-profiles', 'b', '.credentials.json'), '');
    writeFileSync(join(home, '.claude-profiles', 'not-a-dir'), '');

    const profiles = withAuthentication(detectProfiles({}, home), home);
    const claude = profiles.filter((p) => p.runtime === 'claude');

    expect(claude).toEqual([
      {
        id: 'claude-default',
        runtime: 'claude',
        env: {},
        args: [],
        authenticated: false,
      },
      {
        id: 'claude-a',
        runtime: 'claude',
        env: { CLAUDE_CONFIG_DIR: join(home, '.claude-profiles', 'a') },
        args: [],
        authenticated: true,
      },
      {
        id: 'claude-b',
        runtime: 'claude',
        env: { CLAUDE_CONFIG_DIR: join(home, '.claude-profiles', 'b') },
        args: [],
        authenticated: false,
      },
    ]);
  });

  it('marks the default claude profile authenticated from ~/.claude', () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    const [first] = withAuthentication(detectProfiles({}, home), home);
    expect(first).toMatchObject({ id: 'claude-default', authenticated: true });
  });

  it('proposes one codex profile, honouring CODEX_HOME, authenticated by auth.json', () => {
    const codexHome = join(home, 'codex-home');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'auth.json'), '{}');
    const codex = detectProfiles({ CODEX_HOME: codexHome }, home).filter(
      (p) => p.runtime === 'codex',
    );
    expect(codex).toEqual([
      {
        id: 'codex-default',
        runtime: 'codex',
        env: { CODEX_HOME: codexHome },
        args: [],
      },
    ]);
    expect(isAuthenticated(codex[0], home)).toBe(true);
    expect(
      isAuthenticated({ id: 'c', runtime: 'codex', env: {}, args: [] }, home),
    ).toBe(false);
  });

  it('expands ~ in a configured CLAUDE_CONFIG_DIR', () => {
    mkdirSync(join(home, 'p'));
    writeFileSync(join(home, 'p', '.credentials.json'), '{"t":1}');
    expect(
      isAuthenticated(
        {
          id: 'x',
          runtime: 'claude',
          env: { CLAUDE_CONFIG_DIR: '~/p' },
          args: [],
        },
        home,
      ),
    ).toBe(true);
  });

  it('turns odd directory names into valid ids', () => {
    mkdirSync(join(home, '.claude-profiles', 'my profile'), {
      recursive: true,
    });
    mkdirSync(join(home, '.claude-profiles', '.hidden'), { recursive: true });
    const ids = detectProfiles({}, home).map((p) => p.id);
    expect(ids).toContain('claude-my-profile');
    expect(ids).toContain('claude-hidden');
  });
});

describe('capability detection', () => {
  let home = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir: home, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('parses tool versions', () => {
    expect(extractVersion('tmux 3.5a')).toBe('3.5a');
    expect(extractVersion('git version 2.55.0')).toBe('2.55.0');
    expect(extractVersion('2.1.293 (Claude Code)')).toBe('2.1.293');
    expect(extractVersion('codex-cli 0.46.0')).toBe('0.46.0');
    expect(extractVersion('no version here')).toBeNull();
  });

  it('parses the gh user from either auth status wording', () => {
    expect(
      parseGhUser('✓ Logged in to github.com account AndreyBegma (keyring)'),
    ).toBe('AndreyBegma');
    expect(
      parseGhUser('✓ Logged in to github.com as octocat (oauth_token)'),
    ).toBe('octocat');
    expect(parseGhUser('You are not logged into any GitHub hosts')).toBeNull();
  });

  it('reports codex: null when codex is absent, and everything else found', async () => {
    const capabilities = await detectCapabilities({
      exec: machineWithoutCodex(),
      home,
      config: { profiles: [], otlp: null },
    });
    expect(capabilitiesSchema.parse(capabilities)).toEqual({
      tmux: '3.5a',
      git: '2.55.0',
      gh: { version: '2.80.0', authenticated: true, user: 'AndreyBegma' },
      runtimes: { claude: { version: '2.3.1' }, codex: null },
      profiles: [],
      codeSentinel: null,
      otlp: null,
    });
  });

  it('reports gh unauthenticated without a user', async () => {
    const capabilities = await detectCapabilities({
      exec: fakeExec({
        'gh --version': 'gh version 2.80.0',
        'gh auth status': { code: 1, stdout: '', stderr: 'not logged in' },
      }),
      home,
      config: { profiles: [], otlp: null },
    });
    expect(capabilities.gh).toEqual({
      version: '2.80.0',
      authenticated: false,
      user: null,
    });
  });

  it('reads the code-sentinel install of a claude profile', async () => {
    const dir = join(home, '.claude-profiles', 'a');
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(
      join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'other@x': [{ version: '9.9.9', installPath: '/x', scope: 'user' }],
          'code-sentinel@code-sentinel': [
            { version: '1.24.0', installPath: '/p/1.24.0', scope: 'project' },
            { version: '1.23.0', installPath: '/p/1.23.0', scope: 'user' },
          ],
        },
      }),
    );
    expect(readCodeSentinel(dir)).toEqual({
      version: '1.23.0',
      path: '/p/1.23.0',
    });
    expect(readCodeSentinel(join(home, 'nowhere'))).toBeNull();

    const capabilities = await detectCapabilities({
      exec: fakeExec({}),
      home,
      config: {
        profiles: [
          {
            id: 'claude-a',
            runtime: 'claude',
            env: { CLAUDE_CONFIG_DIR: dir },
            args: [],
          },
        ],
        otlp: { grpc: 4317, http: 4318 },
      },
    });
    expect(capabilities.codeSentinel).toEqual({
      version: '1.23.0',
      path: '/p/1.23.0',
    });
    expect(capabilities.otlp).toEqual({ grpc: 4317, http: 4318 });
    expect(capabilities.profiles[0].authenticated).toBe(false);
  });

  it('finds nothing — and does not throw — on an empty PATH', async () => {
    const capabilities = await detectCapabilities({
      exec: createExec({ PATH: '' }),
      home,
      config: { profiles: [], otlp: null },
    });
    expect(capabilities.runtimes).toEqual({ claude: null, codex: null });
    expect(capabilities.tmux).toBeNull();
  });
});
