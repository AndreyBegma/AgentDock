import { describe, expect, it } from 'bun:test';
import type { OrchestratorState } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import {
  orchestratorArgv,
  orchestratorStatus,
  startOrchestrator,
  stopOrchestrator,
} from './orchestrator';
import { CREATED, fakeTmux } from './testing';

const SESSION = 'agentdock-orch-acme-widget';
const target = { projectId: 'prj_1', root: '/srv/widget' };
const start = {
  ...target,
  profileId: 'claude-work',
  model: 'opus',
  permissionMode: 'auto',
  mode: 'start',
} as const;

const claudeWork: ConfigProfile = {
  id: 'claude-work',
  runtime: 'claude',
  binary: '/opt/bin/claude-wrapper',
  env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-profiles/work' },
  args: ['--verbose'],
};
const codex: ConfigProfile = {
  id: 'codex-default',
  runtime: 'codex',
  env: {},
  args: [],
};

const startedIso = new Date(CREATED * 1000).toISOString();

describe('orchestrator.start', () => {
  it('creates agentdock-orch-<slug> in the root with exactly D2 argv and the profile env', async () => {
    const fake = fakeTmux({ profiles: [claudeWork] });

    expect(await startOrchestrator(start, fake.deps)).toEqual({
      session: SESSION,
      startedAt: startedIso,
    });
    const created = fake.tmuxCalls().find((c) => c[0] === 'new-session');
    expect(created).toEqual([
      'new-session',
      '-d',
      '-s',
      SESSION,
      '-c',
      '/srv/widget',
      '-e',
      'CLAUDE_CONFIG_DIR=/home/dev/.claude-profiles/work',
      '/opt/bin/claude-wrapper',
      '--verbose',
      '--remote-control',
      SESSION,
      '-n',
      SESSION,
      '--model',
      'opus',
      '--permission-mode',
      'auto',
      '/code-sentinel:orchestrator start',
    ]);
  });

  it('never involves a shell', async () => {
    const fake = fakeTmux({ profiles: [claudeWork] });
    await startOrchestrator({ ...start, mode: 'next' }, fake.deps);
    // Only tmux and git are executed, and the prompt stays one argv element.
    expect(new Set(fake.calls.map((c) => c[0]))).toEqual(
      new Set(['git', 'tmux']),
    );
    const created = fake.tmuxCalls().find((c) => c[0] === 'new-session');
    expect(created?.at(-1)).toBe('/code-sentinel:orchestrator next');
    expect(created).not.toContain('sh');
    expect(fake.sessions.has(SESSION)).toBe(true);
  });

  it('maps the manual permission mode to the CLI default and uses the runtime as binary', () => {
    const plain: ConfigProfile = {
      id: 'claude-default',
      runtime: 'claude',
      env: {},
      args: [],
    };
    expect(
      orchestratorArgv(plain, SESSION, {
        model: 'claude-opus-5-5',
        permissionMode: 'manual',
        mode: 'next',
      }),
    ).toEqual([
      'claude',
      '--remote-control',
      SESSION,
      '-n',
      SESSION,
      '--model',
      'claude-opus-5-5',
      '--permission-mode',
      'default',
      '/code-sentinel:orchestrator next',
    ]);
  });

  it('answers already_running while the session lives, and creates nothing', async () => {
    const fake = fakeTmux({
      profiles: [claudeWork],
      sessions: { [SESSION]: '' },
    });
    await expect(startOrchestrator(start, fake.deps)).rejects.toMatchObject({
      code: 'already_running',
    });
    expect(fake.tmuxCalls().some((c) => c[0] === 'new-session')).toBe(false);
  });

  it('answers already_running when a concurrent start took the name first', async () => {
    const fake = fakeTmux({
      profiles: [claudeWork],
      newSessionFails: { code: 1, stdout: '', stderr: 'duplicate session' },
    });
    // The other start's session appears between the check and new-session.
    const exec = fake.deps.exec;
    fake.deps.exec = async (binary, args) => {
      const result = await exec(binary, args);
      if (args[0] === 'new-session') fake.sessions.set(SESSION, '');
      return result;
    };
    await expect(startOrchestrator(start, fake.deps)).rejects.toMatchObject({
      code: 'already_running',
    });
  });

  it('fails with the tmux error when new-session fails for another reason', async () => {
    const fake = fakeTmux({
      profiles: [claudeWork],
      newSessionFails: { code: 1, stdout: '', stderr: 'no space left' },
    });
    await expect(startOrchestrator(start, fake.deps)).rejects.toThrow(
      /no space left/,
    );
  });

  it('answers unknown_profile and unsupported_runtime before touching tmux', async () => {
    const fake = fakeTmux({ profiles: [claudeWork, codex] });
    await expect(
      startOrchestrator({ ...start, profileId: 'nope' }, fake.deps),
    ).rejects.toMatchObject({ code: 'unknown_profile' });
    await expect(
      startOrchestrator({ ...start, profileId: 'codex-default' }, fake.deps),
    ).rejects.toMatchObject({ code: 'unsupported_runtime' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a root that is not that project in the watch list', async () => {
    const fake = fakeTmux({ profiles: [claudeWork] });
    for (const wrong of [
      { ...start, root: '/srv/other' },
      { ...start, projectId: 'prj_2' },
    ]) {
      await expect(startOrchestrator(wrong, fake.deps)).rejects.toMatchObject({
        code: 'path_not_allowed',
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it('names the session after the root basename when there is no origin', async () => {
    const fake = fakeTmux({ profiles: [claudeWork], origin: null });
    expect((await startOrchestrator(start, fake.deps)).session).toBe(
      'agentdock-orch-widget',
    );
  });
});

describe('orchestrator.stop', () => {
  it('kills only the orchestrator session; slot sessions keep running', async () => {
    const fake = fakeTmux({
      sessions: { [SESSION]: '', 'cs-i42': '', 'cs-i7': '' },
    });
    expect(await stopOrchestrator(target, fake.deps)).toEqual({
      stopped: true,
    });
    expect(fake.tmuxCalls().filter((c) => c[0] === 'kill-session')).toEqual([
      ['kill-session', '-t', `=${SESSION}`],
    ]);
    expect([...fake.sessions.keys()]).toEqual(['cs-i42', 'cs-i7']);
    // No git call mutates anything: worktrees are never touched.
    expect(
      fake.calls.filter((c) => c[0] === 'git' && c.includes('worktree')),
    ).toEqual([]);
  });

  it('answers stopped: false when it is not running', async () => {
    const fake = fakeTmux({ sessions: { 'cs-i42': '' } });
    expect(await stopOrchestrator(target, fake.deps)).toEqual({
      stopped: false,
    });
    expect(fake.tmuxCalls().some((c) => c[0] === 'kill-session')).toBe(false);
  });
});

describe('orchestrator.status', () => {
  it('is absent without the session', async () => {
    const fake = fakeTmux();
    expect(await orchestratorStatus(target, fake.deps)).toEqual({
      present: false,
      state: 'absent',
    });
  });

  it('reads the pane with the #11 classifier, without typing into it', async () => {
    const cases: [string, OrchestratorState][] = [
      ['✻ Thinking… (esc to interrupt)', 'running'],
      ['> ', 'idle'],
      ['Do you trust the files in this folder?', 'prompt'],
      ["You've hit your weekly limit", 'quota'],
    ];
    for (const [pane, state] of cases) {
      const fake = fakeTmux({ sessions: { [SESSION]: pane } });
      expect(await orchestratorStatus(target, fake.deps)).toEqual({
        present: true,
        state,
        session: SESSION,
        startedAt: startedIso,
      });
      expect(fake.tmuxCalls().some((c) => c[0] === 'send-keys')).toBe(false);
    }
  });
});
