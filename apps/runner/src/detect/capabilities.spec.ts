import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeExec, tempDir } from '../testing/fixtures';
import {
  commandsCapability,
  detectCapabilities,
  ptyAvailable,
  readProfileAgentdock,
  terminalCapability,
  terminalUnsupported,
  versionAtLeast,
} from './capabilities';

describe('versionAtLeast', () => {
  it('compares the leading numbers', () => {
    expect(versionAtLeast('3.2', [3, 2])).toBe(true);
    expect(versionAtLeast('3.2a', [3, 2])).toBe(true);
    expect(versionAtLeast('3.5a', [3, 2])).toBe(true);
    expect(versionAtLeast('4.0', [3, 2])).toBe(true);
    expect(versionAtLeast('3.1c', [3, 2])).toBe(false);
    expect(versionAtLeast('2.9', [3, 2])).toBe(false);
    expect(versionAtLeast('1.3.5', [1, 3, 5])).toBe(true);
    expect(versionAtLeast('1.3.4', [1, 3, 5])).toBe(false);
    expect(versionAtLeast('1.4', [1, 3, 5])).toBe(true);
    expect(versionAtLeast(null, [3, 2])).toBe(false);
    expect(versionAtLeast('next', [3, 2])).toBe(false);
  });
});

describe('terminal capability (spec 29 D3, D10)', () => {
  it('is true with a PTY and tmux ≥ 3.2', () => {
    expect(
      terminalCapability({ tmux: '3.5a', disabledCommands: [], pty: true }),
    ).toBe(true);
  });

  it('is false when terminal.attach is in disabledCommands', () => {
    expect(
      terminalCapability({
        tmux: '3.5a',
        disabledCommands: ['terminal.attach'],
        pty: true,
      }),
    ).toBe(false);
  });

  it('is false without a PTY API, without tmux, or with tmux < 3.2', () => {
    expect(
      terminalCapability({ tmux: '3.5a', disabledCommands: [], pty: false }),
    ).toBe(false);
    expect(
      terminalCapability({ tmux: null, disabledCommands: [], pty: true }),
    ).toBe(false);
    expect(
      terminalCapability({ tmux: '3.1c', disabledCommands: [], pty: true }),
    ).toBe(false);
    expect(terminalUnsupported('3.1c', true)).toContain('tmux 3.1c');
    expect(terminalUnsupported('3.5a', false)).toContain('PTY');
  });

  it('finds the PTY API on the Bun the runner is built with', () => {
    expect(ptyAvailable()).toBe(process.platform !== 'win32');
  });
});

describe('commands capability (#233)', () => {
  const handlers = {
    'worktree.status': 1,
    'plan.turn': 2,
    'runner.describe': 3,
  };

  it('lists the handler keys sorted', () => {
    expect(commandsCapability(handlers, []).commands).toEqual([
      'plan.turn',
      'runner.describe',
      'worktree.status',
    ]);
  });

  it('intersects the config with what the build serves, sorted and unique', () => {
    expect(
      commandsCapability(handlers, [
        'worktree.status',
        'plan.turn',
        'worktree.status',
        'gone.command',
      ]).disabledCommands,
    ).toEqual(['plan.turn', 'worktree.status']);
  });

  it('has no disabled commands when the config disables none', () => {
    expect(commandsCapability(handlers, []).disabledCommands).toEqual([]);
  });
});

describe('agentdock plugin and telemetry per profile (#281 D1)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  const writePlugins = (plugins: Record<string, unknown>) => {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(
      join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins }),
    );
  };
  const writeEndpoint = (endpoint: unknown) =>
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } }),
    );

  it('reports plugin: null and telemetry: false for an empty profile', () => {
    expect(readProfileAgentdock(dir, 4318)).toEqual({
      plugin: null,
      telemetry: false,
    });
  });

  it('reads the agentdock version, user scope first, ignoring other plugins', () => {
    writePlugins({
      'code-sentinel@code-sentinel': [
        { version: '1.24.0', installPath: '/c', scope: 'user' },
      ],
      'agentdock@agentdock': [
        { version: '0.3.0', installPath: '/p/0.3.0', scope: 'project' },
        { version: '0.2.0', installPath: '/p/0.2.0', scope: 'user' },
      ],
    });
    expect(readProfileAgentdock(dir, null).plugin).toBe('0.2.0');
  });

  it('is null for a profile with only other plugins or a broken file', () => {
    writePlugins({
      'code-sentinel@code-sentinel': [
        { version: '1.24.0', installPath: '/c', scope: 'user' },
      ],
    });
    expect(readProfileAgentdock(dir, 4318).plugin).toBeNull();
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), '{nope');
    expect(readProfileAgentdock(dir, 4318).plugin).toBeNull();
  });

  it("is telemetry: true only when the endpoint is this runner's OTLP port", () => {
    writeEndpoint('http://127.0.0.1:4318');
    expect(readProfileAgentdock(dir, 4318).telemetry).toBe(true);
    expect(readProfileAgentdock(dir, 4319).telemetry).toBe(false);
    expect(readProfileAgentdock(dir, null).telemetry).toBe(false);
    writeEndpoint('http://localhost:4318');
    expect(readProfileAgentdock(dir, 4318).telemetry).toBe(true);
    writeEndpoint('http://collector.example:4318');
    expect(readProfileAgentdock(dir, 4318).telemetry).toBe(false);
    writeEndpoint('not a url');
    expect(readProfileAgentdock(dir, 4318).telemetry).toBe(false);
    writeEndpoint(4318);
    expect(readProfileAgentdock(dir, 4318).telemetry).toBe(false);
  });

  it('is reported for claude profiles only', async () => {
    writePlugins({
      'agentdock@agentdock': [
        { version: '0.2.0', installPath: '/p', scope: 'user' },
      ],
    });
    writeEndpoint('http://127.0.0.1:4318');
    const capabilities = await detectCapabilities({
      exec: fakeExec({}),
      home: dir,
      config: {
        profiles: [
          {
            id: 'claude-a',
            runtime: 'claude',
            env: { CLAUDE_CONFIG_DIR: dir },
            args: [],
          },
          { id: 'codex-default', runtime: 'codex', env: {}, args: [] },
        ],
        otlp: { grpc: null, http: 4318 },
      },
    });
    expect(capabilities.profiles[0].agentdock).toEqual({
      plugin: '0.2.0',
      telemetry: true,
    });
    expect(capabilities.profiles[1].agentdock).toBeUndefined();
  });
});
