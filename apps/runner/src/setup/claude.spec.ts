import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ConfigProfile } from '../config';
import { createExec } from '../detect/exec';
import { tempDir } from '../testing/fixtures';
import { EXPORTER_KEYS, type SetupClaudeOptions, setupClaude } from './claude';

describe('nautelle-runner setup claude (spec 201 D21)', () => {
  let dir = '';
  let cleanup = () => {};
  let stdout: string[] = [];
  let stderr: string[] = [];

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    stdout = [];
    stderr = [];
    // A fake `claude` that logs its argv and config dir, and fails on demand.
    mkdirSync(join(dir, 'bin'));
    const script = join(dir, 'bin', 'claude');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `echo "$CLAUDE_CONFIG_DIR $*" >> "${join(dir, 'calls.log')}"`,
        'if [ -n "$FAKE_CLAUDE_FAIL" ]; then echo "$FAKE_CLAUDE_FAIL" >&2; exit 1; fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
  });
  afterEach(() => cleanup());

  const configDir = () => join(dir, 'profiles', 'work');
  const settingsPath = () => join(configDir(), 'settings.json');
  const profiles = (): ConfigProfile[] => [
    {
      id: 'claude-work',
      runtime: 'claude',
      env: { CLAUDE_CONFIG_DIR: '~/profiles/work' },
      args: [],
    },
    { id: 'codex-x', runtime: 'codex', env: {}, args: [] },
  ];
  const calls = (): string[] =>
    existsSync(join(dir, 'calls.log'))
      ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
      : [];

  const run = (overrides: Partial<SetupClaudeOptions> = {}) =>
    setupClaude({
      profiles: profiles(),
      telemetry: true,
      dryRun: false,
      uninstall: false,
      otlpPort: 4318,
      home: dir,
      env: { PATH: join(dir, 'bin'), HOME: dir },
      exec: (env) => createExec(env),
      stdout: (t) => stdout.push(t),
      stderr: (t) => stderr.push(t),
      ...overrides,
    });

  const original = {
    theme: 'dark',
    env: { FOO: 'bar', OTEL_METRICS_EXPORTER: 'console' },
  };
  const writeOriginal = () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(original, null, 2)}\n`);
  };

  it('--dry-run prints the plugin commands and the diff and writes nothing', async () => {
    writeOriginal();
    expect(await run({ dryRun: true })).toBe(0);
    const text = stdout.join('');
    expect(text).toContain(
      'claude plugin marketplace add AndreyBegma/AgentDock',
    );
    expect(text).toContain(
      'claude plugin install nautelle@nautelle --scope user',
    );
    expect(text).toContain(
      '+  env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"',
    );
    expect(text).toContain('-  env.OTEL_METRICS_EXPORTER = "console"');
    expect(calls()).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual(original);
    expect(existsSync(`${settingsPath()}.bak`)).toBe(false);
  });

  it('installs per Claude profile with CLAUDE_CONFIG_DIR set and merges only the exporter keys', async () => {
    writeOriginal();
    expect(await run()).toBe(0);
    expect(calls()).toEqual([
      `${configDir()} plugin marketplace add AndreyBegma/AgentDock`,
      `${configDir()} plugin install nautelle@nautelle --scope user`,
    ]);
    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(settings.env).toEqual({
      FOO: 'bar',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    });
    const text = readFileSync(settingsPath(), 'utf8');
    expect(text).not.toContain('OTEL_RESOURCE_ATTRIBUTES');
    expect(text).not.toMatch(/OTEL_LOG_/);
    expect(JSON.parse(readFileSync(`${settingsPath()}.bak`, 'utf8'))).toEqual(
      original,
    );
  });

  it('is idempotent: a second run leaves one .bak and the same settings', async () => {
    writeOriginal();
    await run();
    const first = readFileSync(settingsPath(), 'utf8');
    stdout = [];
    expect(await run()).toBe(0);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(first);
    expect(readdirSync(configDir()).sort()).toEqual([
      'settings.json',
      'settings.json.bak',
    ]);
    expect(stdout.join('')).toContain('up to date');
    expect(JSON.parse(readFileSync(`${settingsPath()}.bak`, 'utf8'))).toEqual(
      original,
    );
  });

  it('--uninstall restores the earlier env and removes the plugin', async () => {
    writeOriginal();
    await run();
    expect(await run({ uninstall: true })).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual(original);
    expect(calls().slice(2)).toEqual([
      `${configDir()} plugin uninstall nautelle@nautelle --scope user`,
      `${configDir()} plugin marketplace remove nautelle`,
    ]);
  });

  it('removes the plugin installed under its old name first (ADR-0073)', async () => {
    writeOriginal();
    mkdirSync(join(configDir(), 'plugins'), { recursive: true });
    writeFileSync(
      join(configDir(), 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'agentdock@agentdock': [
            { scope: 'user', version: '0.13.0', installPath: '/x' },
          ],
        },
      }),
    );
    expect(await run()).toBe(0);
    expect(calls()).toEqual([
      `${configDir()} plugin uninstall agentdock@agentdock --scope user`,
      `${configDir()} plugin marketplace remove agentdock`,
      `${configDir()} plugin marketplace add AndreyBegma/AgentDock`,
      `${configDir()} plugin install nautelle@nautelle --scope user`,
    ]);
  });

  it('creates settings.json when there is none, and --uninstall removes the keys again', async () => {
    expect(await run()).toBe(0);
    expect(
      Object.keys(JSON.parse(readFileSync(settingsPath(), 'utf8')).env),
    ).toEqual(EXPORTER_KEYS);
    expect(existsSync(`${settingsPath()}.bak`)).toBe(false);
    await run({ uninstall: true });
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({});
  });

  it('--no-telemetry installs the plugin and leaves settings.json alone', async () => {
    writeOriginal();
    await run({ telemetry: false });
    expect(calls()).toHaveLength(2);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual(original);
  });

  it('treats an already-added marketplace as done', async () => {
    const result = await run({
      env: {
        PATH: join(dir, 'bin'),
        HOME: dir,
        FAKE_CLAUDE_FAIL: 'Marketplace agentdock is already installed',
      },
    });
    expect(result).toBe(0);
    expect(calls()).toHaveLength(2);
  });

  it('prints when the change shows up, after a successful setup only (#348 D7)', async () => {
    const line = 'A running nautelle-runner reports this within 15 seconds.';
    expect(await run()).toBe(0);
    expect(stdout.join('')).toContain(line);

    stdout = [];
    await run({ dryRun: true });
    expect(stdout.join('')).not.toContain(line);

    stdout = [];
    await run({ uninstall: true });
    expect(stdout.join('')).not.toContain(line);

    stdout = [];
    expect(
      await run({
        env: {
          PATH: join(dir, 'bin'),
          HOME: dir,
          FAKE_CLAUDE_FAIL: 'network down',
        },
      }),
    ).toBe(1);
    expect(stdout.join('')).not.toContain(line);
  });

  it('fails on a real plugin error', async () => {
    const result = await run({
      env: {
        PATH: join(dir, 'bin'),
        HOME: dir,
        FAKE_CLAUDE_FAIL: 'network down',
      },
    });
    expect(result).toBe(1);
    expect(stderr.join('')).toContain('network down');
    expect(calls()).toHaveLength(1);
  });

  it('leaves invalid settings.json untouched', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(settingsPath(), '{ nope');
    expect(await run()).toBe(1);
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ nope');
    expect(stderr.join('')).toContain('not valid JSON');
  });

  it('--profile picks one profile; an unknown one is an error', async () => {
    expect(await run({ profile: 'nope', dryRun: true })).toBe(1);
    expect(await run({ profile: 'claude-work', dryRun: true })).toBe(0);
  });
});
