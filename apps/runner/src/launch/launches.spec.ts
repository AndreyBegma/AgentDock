import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenSaverConfig } from '@agentdock/shared';
import type { CardRunArgs, SkillRunArgs } from '@agentdock/shared/protocol';
import { cardLaunchSpec, cardTokenSaver } from '../cards/launch';
import type { CardWiring } from '../cards/wiring';
import type { ConfigProfile } from '../config';
import {
  orchestratorArgv,
  orchestratorTokenSaver,
} from '../control/orchestrator';
import {
  FILTER_PROJECT_ENV,
  FILTER_RUN_ENV,
  FILTER_RUN_KIND_ENV,
} from '../filter/env';
import { planTurnLaunchSpec, planTurnTokenSaver } from '../planner/launch';
import { launchSpec, skillTokenSaver } from '../skills/run/launch';
import { FakeClock } from '../testing/fake-clock';
import { fakeExec, tempDir } from '../testing/fixtures';
import {
  uiProfileLaunchSpec,
  uiProfileTokenSaver,
} from '../uiprofile/executor';
import { AUTOCOMPACT_ENV, type TokenSaverLaunch } from './token-saver';

/**
 * #445 acceptance: every launch passes `--settings` and `--strict-mcp-config`
 * when Token saver is on, and launches exactly as today when it is off.
 * The three headless text calls are covered in their executors' specs.
 */

const SELF = ['/opt/agentdock-runner'];
const S1 = '11111111-1111-4111-8111-111111111111';
const ON: TokenSaverConfig = { enabled: true, mcpAllow: ['playwright'] };
const OFF: TokenSaverConfig = { enabled: false, mcpAllow: ['playwright'] };

let home = '';
let dir = '';
let cleanup = () => {};
let profile: ConfigProfile;

beforeEach(() => {
  ({ dir: home, cleanup } = tempDir());
  dir = home;
  profile = {
    id: 'claude-work',
    runtime: 'claude',
    binary: '/opt/claude',
    env: {},
    args: ['--verbose-profile'],
  };
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { playwright: { command: 'pw' } } }),
  );
});
afterEach(() => cleanup());

const serversOf = (launch: TokenSaverLaunch | null): Record<string, unknown> =>
  JSON.parse(readFileSync(launch?.mcpFile ?? '', 'utf8')).mcpServers;

/** The flags sit together, before `--model`, so a variadic flag ends there. */
const expectWired = (args: readonly string[], launch: TokenSaverLaunch) => {
  const at = args.indexOf('--settings');
  expect(at).toBeGreaterThan(0);
  expect(args.slice(at, at + launch.args.length)).toEqual(launch.args);
  expect(at + launch.args.length).toBeLessThanOrEqual(args.indexOf('--model'));
  expect(launch.args.slice(0, 3)).toEqual([
    '--settings',
    launch.settingsFile,
    '--strict-mcp-config',
  ]);
};

describe('card worker launch (#445)', () => {
  const args: Pick<
    CardRunArgs,
    | 'session'
    | 'model'
    | 'permissionMode'
    | 'prompt'
    | 'projectId'
    | 'runId'
    | 'shortId'
    | 'tokenSaver'
    | 'pullRequest'
  > = {
    session: { id: S1, resume: false },
    model: 'opus',
    permissionMode: 'auto',
    prompt: 'You are the worker\nGitHub issue: #12',
    projectId: 'prj_a',
    runId: 'run_1',
    shortId: 'abcd1234',
  };
  const injected: CardWiring = {
    wiring: 'injected',
    files: {
      settings: '/r/agentdock-settings.json',
      mcp: '/r/agentdock-mcp.json',
    },
  };

  it('is today’s launch when off or absent', () => {
    for (const config of [undefined, OFF]) {
      const ts = cardTokenSaver(
        profile,
        { ...args, tokenSaver: config },
        home,
        dir,
        SELF,
        injected,
      );
      expect(ts).toBeNull();
      expect(
        cardLaunchSpec(profile, args, '/w', null, injected.files, ts),
      ).toEqual(cardLaunchSpec(profile, args, '/w', null, injected.files));
    }
  });

  it('carries the injected hooks, the filter hook, agentdock with the guard, and the scout', () => {
    const ts = cardTokenSaver(
      profile,
      { ...args, tokenSaver: ON },
      home,
      dir,
      SELF,
      injected,
    );
    if (!ts) throw new Error('expected a launch');
    const spec = cardLaunchSpec(profile, args, '/w', null, injected.files, ts);
    expectWired(spec.args, ts);
    expect(spec.args).not.toContain(injected.files?.settings);
    expect(spec.args).toContain('--agents');
    expect(spec.args.slice(-2)).toEqual(['--', args.prompt]);
    const settings = JSON.parse(readFileSync(ts.settingsFile, 'utf8'));
    expect(Object.keys(settings.hooks)).toContain('SessionStart');
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(serversOf(ts)).toEqual({
      agentdock: {
        command: SELF[0],
        args: ['mcp', '--finish-guard', '--issue', '12'],
      },
      playwright: { command: 'pw' },
    });
    expect(spec.env[AUTOCOMPACT_ENV]).toBe('60');
    expect(spec.env[FILTER_RUN_ENV]).toBe('run_1');
    expect(spec.env.AGENTDOCK_CARD).toBe('abcd1234');
  });

  it('leaves a plugin profile its own hooks: only the filter hook', () => {
    const ts = cardTokenSaver(
      profile,
      { ...args, tokenSaver: ON },
      home,
      dir,
      SELF,
      { wiring: 'plugin' },
    );
    const settings = JSON.parse(readFileSync(ts?.settingsFile ?? '', 'utf8'));
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse']);
  });
});

describe('skill run launch (#445)', () => {
  const args: SkillRunArgs = {
    runId: 'run_1',
    projectId: 'prj_a',
    root: '/p',
    base: 'main',
    skill: 'code-sentinel:review',
    args: '',
    profileKey: 'claude-work',
    model: 'sonnet',
    permissionMode: 'auto',
    output: 'report',
    timeoutSec: 600,
  };

  it('is today’s launch when off or absent', () => {
    for (const config of [undefined, OFF]) {
      const ts = skillTokenSaver(
        profile,
        { ...args, tokenSaver: config },
        home,
        dir,
        SELF,
      );
      expect(ts).toBeNull();
      expect(launchSpec(profile, args, '/w', null, ts)).toEqual(
        launchSpec(profile, args, '/w', null),
      );
    }
  });

  it('wires it before `-p` when on, with agentdock and the scout', () => {
    const ts = skillTokenSaver(
      profile,
      { ...args, tokenSaver: ON },
      home,
      dir,
      SELF,
    );
    if (!ts) throw new Error('expected a launch');
    const spec = launchSpec(profile, args, '/w', null, ts);
    expectWired(spec.args, ts);
    expect(spec.args.indexOf('-p')).toBe(1 + ts.args.length);
    expect(ts.args).toContain('--agents');
    expect(Object.keys(serversOf(ts)).sort()).toEqual([
      'agentdock',
      'playwright',
    ]);
    expect(spec.env[FILTER_RUN_KIND_ENV]).toBe('skill');
  });
});

describe('plan turn launch (#445)', () => {
  const args = {
    session: { id: S1, resume: false },
    model: 'opus' as const,
    projectId: 'prj_a',
    runId: 'run_1',
  };

  it('is today’s launch when off or absent', () => {
    for (const config of [undefined, OFF]) {
      const ts = planTurnTokenSaver(
        profile,
        { ...args, tokenSaver: config },
        home,
        dir,
        SELF,
      );
      expect(ts).toBeNull();
      expect(
        planTurnLaunchSpec(profile, args, '/w', '/r/prompt.md', null, ts),
      ).toEqual(planTurnLaunchSpec(profile, args, '/w', '/r/prompt.md', null));
    }
  });

  it('wires it when on, with agentdock and the scout', () => {
    const ts = planTurnTokenSaver(
      profile,
      { ...args, tokenSaver: ON },
      home,
      dir,
      SELF,
    );
    if (!ts) throw new Error('expected a launch');
    const spec = planTurnLaunchSpec(profile, args, '/w', '/r/p.md', null, ts);
    expectWired(spec.args, ts);
    expect(Object.keys(serversOf(ts))).toContain('agentdock');
    expect(spec.env[FILTER_RUN_KIND_ENV]).toBe('plan');
  });
});

describe('design build launch (#445)', () => {
  const build = { model: 'opus' as const, projectId: 'prj_a', runId: 'run_1' };

  it('is today’s launch when off or absent', () => {
    for (const config of [undefined, OFF]) {
      const ts = uiProfileTokenSaver(
        profile,
        { ...build, tokenSaver: config },
        home,
        dir,
        SELF,
      );
      expect(ts).toBeNull();
      expect(
        uiProfileLaunchSpec(profile, build, '/w', '/r/prompt.md', null, ts),
      ).toEqual({
        binary: '/opt/claude',
        args: [
          '--verbose-profile',
          '-p',
          '--model',
          'opus',
          '--permission-mode',
          'plan',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        env: expect.any(Object),
        cwd: '/w',
        stdin: '/r/prompt.md',
      });
    }
  });

  it('wires it when on, without agentdock', () => {
    const ts = uiProfileTokenSaver(
      profile,
      { ...build, tokenSaver: ON },
      home,
      dir,
      SELF,
    );
    if (!ts) throw new Error('expected a launch');
    const spec = uiProfileLaunchSpec(profile, build, '/w', '/r/p.md', null, ts);
    expectWired(spec.args, ts);
    expect(Object.keys(serversOf(ts))).toEqual(['playwright']);
    expect(spec.env[FILTER_RUN_KIND_ENV]).toBe('ui_profile');
  });
});

describe('orchestrator session launch (#445)', () => {
  const args = {
    model: 'opus' as const,
    permissionMode: 'auto' as const,
    mode: 'start' as const,
  };
  const deps = () => ({
    exec: fakeExec({}),
    clock: new FakeClock(),
    watchedProjects: () => [],
    profiles: () => [profile],
    home,
    selfCommand: SELF,
    orchestratorDir: join(dir, 'orchestrator'),
  });

  it('is today’s launch when off or absent', async () => {
    for (const config of [undefined, OFF]) {
      const ts = await orchestratorTokenSaver(
        { tokenSaver: config, projectId: 'prj_a' },
        deps(),
        profile,
        'cs-orch',
      );
      expect(ts).toBeNull();
      expect(orchestratorArgv(profile, 'cs-orch', args, ts)).toEqual(
        orchestratorArgv(profile, 'cs-orch', args),
      );
    }
  });

  it('wires it when on, in a directory of the session’s own, with no run id', async () => {
    const ts = await orchestratorTokenSaver(
      { tokenSaver: ON, projectId: 'prj_a' },
      deps(),
      profile,
      'cs-orch',
    );
    if (!ts) throw new Error('expected a launch');
    expect(
      ts.settingsFile.startsWith(join(dir, 'orchestrator', 'cs-orch')),
    ).toBe(true);
    const argv = orchestratorArgv(profile, 'cs-orch', args, ts);
    expectWired(argv.slice(1), ts);
    expect(argv.at(-1)).toBe('/code-sentinel:orchestrator start');
    expect(Object.keys(serversOf(ts)).sort()).toEqual([
      'agentdock',
      'playwright',
    ]);
    expect(ts.env[FILTER_RUN_KIND_ENV]).toBe('orchestrator');
    expect(ts.env[FILTER_PROJECT_ENV]).toBe('prj_a');
    expect(ts.env[FILTER_RUN_ENV]).toBeUndefined();
  });
});
