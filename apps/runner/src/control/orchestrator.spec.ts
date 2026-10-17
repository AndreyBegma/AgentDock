import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorState } from '@agentdock/shared/protocol';
import { createDispatcher } from '../commands/dispatcher';
import { createHandlers } from '../commands/handlers';
import type { ConfigProfile } from '../config';
import { permissivePolicy, sameRealpath } from '../policy/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import {
  messageOrchestrator,
  ORCHESTRATOR_MESSAGE_DIR,
  orchestratorArgv,
  orchestratorMessagePrompt,
  orchestratorStatus,
  startOrchestrator,
  stopOrchestrator,
} from './orchestrator';
import { CREATED, FAKE_SELF_COMMAND, fakeTmux } from './testing';

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
  it('creates agentdock-orch-<slug> in the root, running exec-run on a 0600 launch file with D2 argv and the profile env', async () => {
    const fake = fakeTmux({ profiles: [claudeWork] });

    expect(await startOrchestrator(start, fake.deps)).toEqual({
      session: SESSION,
      startedAt: startedIso,
    });
    const dir = join(fake.deps.orchestratorDir ?? '', SESSION);
    const created = fake.tmuxCalls().find((c) => c[0] === 'new-session');
    expect(created).toEqual([
      'new-session',
      '-d',
      '-s',
      SESSION,
      '-c',
      '/srv/widget',
      ...FAKE_SELF_COMMAND,
      'exec-run',
      dir,
    ]);
    const launch = join(dir, 'run.json');
    expect(statSync(launch).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(launch, 'utf8'))).toEqual({
      binary: '/opt/bin/claude-wrapper',
      args: [
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
      ],
      env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-profiles/work' },
      cwd: '/srv/widget',
      interactive: true,
      label: 'agentdock orchestrator',
    });
    await stopOrchestrator(target, fake.deps);
  });

  it('C-123: never puts a profile env value on the tmux argv', async () => {
    const secret = 'sk-ant-x';
    const fake = fakeTmux({
      profiles: [
        {
          ...claudeWork,
          env: { ...claudeWork.env, ANTHROPIC_API_KEY: secret },
        },
      ],
    });
    await startOrchestrator(start, fake.deps);
    const created = fake.tmuxCalls().find((c) => c[0] === 'new-session') ?? [];
    expect(created).not.toContain('-e');
    expect(created.some((arg) => arg.includes('='))).toBe(false);
    expect(created.some((arg) => arg.includes(secret))).toBe(false);

    const launch = join(fake.deps.orchestratorDir ?? '', SESSION, 'run.json');
    expect(JSON.parse(readFileSync(launch, 'utf8')).env.ANTHROPIC_API_KEY).toBe(
      secret,
    );
    // Stopping takes the env file with the session.
    await stopOrchestrator(target, fake.deps);
    expect(existsSync(launch)).toBe(false);
  });

  it('never involves a shell', async () => {
    const fake = fakeTmux({ profiles: [claudeWork] });
    await startOrchestrator({ ...start, mode: 'next' }, fake.deps);
    // Only tmux and git are executed, and the prompt stays one argv element.
    expect(new Set(fake.calls.map((c) => c[0]))).toEqual(
      new Set(['git', 'tmux']),
    );
    const created = fake.tmuxCalls().find((c) => c[0] === 'new-session');
    expect(created).not.toContain('sh');
    const launch = JSON.parse(
      readFileSync(
        join(fake.deps.orchestratorDir ?? '', SESSION, 'run.json'),
        'utf8',
      ),
    );
    expect(launch.args.at(-1)).toBe('/code-sentinel:orchestrator next');
    expect(fake.sessions.has(SESSION)).toBe(true);
    await stopOrchestrator(target, fake.deps);
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

  it('removes the session’s raw outputs, and keeps its other files (#445)', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const fake = fakeTmux({ sessions: { [SESSION]: '' } });
      const sessionDir = join(dir, SESSION);
      mkdirSync(join(sessionDir, 'raw'), { recursive: true });
      writeFileSync(join(sessionDir, 'raw', '1.log'), 'secret output');
      writeFileSync(join(sessionDir, 'filter-stats.jsonl'), '');
      await stopOrchestrator(target, { ...fake.deps, orchestratorDir: dir });
      expect(existsSync(join(sessionDir, 'raw'))).toBe(false);
      expect(existsSync(join(sessionDir, 'filter-stats.jsonl'))).toBe(true);
    } finally {
      cleanup();
    }
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

describe('orchestrator.message', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  /** A real directory as the git common dir, so the file can be read back. */
  const gitDir = () => {
    const dir = tempDir();
    cleanup = dir.cleanup;
    return realpathSync(dir.dir);
  };
  const message = {
    ...target,
    body: 'Hold i43 until #188 merges.\n\nThen dispatch it.',
    from: 'dev@example.com',
  };
  const messageDir = (dir: string) => join(dir, ORCHESTRATOR_MESSAGE_DIR);

  it('writes the body to its own file in the git dir, then types the prompt and submits with C-m as a separate call', async () => {
    const dir = gitDir();
    const fake = fakeTmux({ gitDir: dir, sessions: { [SESSION]: '> ' } });

    expect(await messageOrchestrator(message, fake.deps)).toEqual({
      delivered: true,
    });
    const [name, ...others] = readdirSync(messageDir(dir));
    expect(others).toEqual([]);
    expect(name).toMatch(/^msg-2026-10-08T10-00-00-000Z-[0-9a-f]{6}\.md$/);
    const file = join(messageDir(dir), name ?? '');
    expect(readFileSync(file, 'utf8')).toBe(
      'From: dev@example.com via AgentDock\n' +
        'Date: 2026-10-08T10:00:00.000Z\n' +
        '\n' +
        'Hold i43 until #188 merges.\n\nThen dispatch it.\n',
    );
    // The body is never typed: only the fixed prompt, then the submit alone.
    expect(fake.tmuxCalls().filter((c) => c[0] === 'send-keys')).toEqual([
      [
        'send-keys',
        '-t',
        `=${SESSION}:`,
        '-l',
        orchestratorMessagePrompt(file),
      ],
      ['send-keys', '-t', `=${SESSION}:`, 'C-m'],
    ]);
  });

  it('keeps every message: a second one gets a file of its own', async () => {
    const dir = gitDir();
    const fake = fakeTmux({ gitDir: dir, sessions: { [SESSION]: '> ' } });
    await messageOrchestrator(message, fake.deps);
    await messageOrchestrator({ ...message, body: 'second' }, fake.deps);
    expect(readdirSync(messageDir(dir))).toHaveLength(2);
  });

  it('writes and types nothing when the orchestrator is not running', async () => {
    const dir = gitDir();
    const fake = fakeTmux({ gitDir: dir });
    expect(await messageOrchestrator(message, fake.deps)).toEqual({
      delivered: false,
      reason: 'absent',
    });
    expect(existsSync(messageDir(dir))).toBe(false);
    expect(fake.tmuxCalls().some((c) => c[0] === 'send-keys')).toBe(false);
  });

  it('writes and types nothing while the pane shows a dialog, which the submit would answer', async () => {
    const dir = gitDir();
    const fake = fakeTmux({
      gitDir: dir,
      sessions: { [SESSION]: 'Do you trust the files in this folder?' },
    });
    expect(await messageOrchestrator(message, fake.deps)).toEqual({
      delivered: false,
      reason: 'prompt',
    });
    expect(existsSync(messageDir(dir))).toBe(false);
    expect(fake.tmuxCalls().some((c) => c[0] === 'send-keys')).toBe(false);
  });

  it('delivers while the orchestrator is busy: the prompt queues behind its turn', async () => {
    const fake = fakeTmux({
      gitDir: gitDir(),
      sessions: { [SESSION]: '✻ Thinking… (esc to interrupt)' },
    });
    expect(await messageOrchestrator(message, fake.deps)).toEqual({
      delivered: true,
    });
  });

  it('refuses a root that is not that project in the watch list', async () => {
    const fake = fakeTmux({ sessions: { [SESSION]: '> ' } });
    await expect(
      messageOrchestrator({ ...message, root: '/srv/other' }, fake.deps),
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
    expect(fake.tmuxCalls()).toEqual([]);
  });

  it('refuses a session, argv or slot field through the dispatcher', async () => {
    const fake = fakeTmux({ sessions: { [SESSION]: '> ' } });
    const clock = new FakeClock();
    const dispatch = createDispatcher({
      policy: permissivePolicy,
      realpath: sameRealpath,
      handlers: createHandlers({
        policy: permissivePolicy,
        clock,
        runnerVersion: '0.0.0-test',
        host: { hostname: 'h', os: 'linux', arch: 'x64' },
        detectCapabilities: () => Promise.reject(new Error('unused')),
        exec: fake.deps.exec,
        watchedProjects: fake.deps.watchedProjects,
        profiles: () => [],
      }),
      disabledCommands: [],
      clock,
      log: memoryLogger().log,
    });
    for (const extra of [
      { session: 'cs-i42' },
      { argv: ['sh', '-c', 'id'] },
      { slot: 'i42' },
    ]) {
      const result = await dispatch({
        type: 'command',
        id: 'c1',
        name: 'orchestrator.message',
        args: { ...message, ...extra },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_args' },
      });
    }
    expect(fake.calls).toEqual([]);
  });
});
