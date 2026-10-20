import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ConfigProfile } from '../config';
import { createExec, type Exec } from '../detect/exec';
import { permissivePolicy } from '../policy/testing';
import { FakeClock } from '../testing/fake-clock';
import { REAL_PROCESS_TIMEOUT_MS, workspace } from '../testing/projects';
import { releaseTmuxServer } from '../testing/tmux';
import type { ControlDeps } from './deps';
import {
  messageOrchestrator,
  ORCHESTRATOR_MESSAGE_DIR,
  orchestratorMessagePrompt,
  startOrchestrator,
  stopOrchestrator,
} from './orchestrator';
import { MESSAGE_FILE, messageSlot, stopSlot } from './slot';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS);

/**
 * Spec 17's acceptance criteria against a real tmux. The server is private
 * (`tmux -L <name>`): the user's own server — where live fleets run — is
 * never listed, let alone touched.
 */
const tmuxInstalled = Bun.which('tmux') !== null;
const SESSION = 'nautelle-orch-acme-widget';

let ws: ReturnType<typeof workspace> | undefined;
let killServer: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await killServer?.();
  ws?.cleanup();
});

/** Polls `check` every 25 ms for up to 15 s. */
const eventually = async (check: () => boolean) => {
  for (let i = 0; i < 600 && !check(); i++) await Bun.sleep(25);
  return check();
};

const fixture = async () => {
  ws = workspace();
  const root = await ws.repo('widget', 'git@github.com:acme/widget.git');
  await ws.commit('widget');
  for (const slot of ['i42', 'i7']) {
    await ws.run(
      root,
      'worktree',
      'add',
      '-q',
      '-b',
      `feat/${slot}`,
      join(ws.ws, `.wt-widget-${slot}`),
    );
  }

  // The profile's binary: records its env and argv (one per line), then
  // sleeps. Each file is written under a temp name and renamed into place, and
  // the argv file lands last — its existence means the whole record is there.
  const record = join(ws.ws, 'record');
  const binary = join(ws.ws, 'fake-claude');
  writeFileSync(
    binary,
    [
      '#!/bin/sh',
      'env > "$RECORD.env.tmp" && mv "$RECORD.env.tmp" "$RECORD.env"',
      'printf \'%s\\n\' "$@" > "$RECORD.argv.tmp" && mv "$RECORD.argv.tmp" "$RECORD.argv"',
      'exec sleep 600',
      '',
    ].join('\n'),
  );
  chmodSync(binary, 0o755);
  const profile: ConfigProfile = {
    id: 'claude-fake',
    runtime: 'claude',
    binary,
    env: {
      CLAUDE_CONFIG_DIR: join(ws.ws, 'profile'),
      RECORD: record,
      ANTHROPIC_API_KEY: 'sk-ant-x',
    },
    args: ['--fake-flag'],
  };

  const server = ['-L', `agentdock-test-${process.pid}-${Date.now()}`];
  const tmuxExec = createExec({ PATH: process.env.PATH, HOME: ws.ws });
  const tmux = (...args: string[]) => tmuxExec('tmux', [...server, ...args]);
  killServer = () => releaseTmuxServer(server);
  const git = ws.git;
  const exec: Exec = (bin, args) =>
    bin === 'git' ? git(bin, args) : tmuxExec(bin, args);

  for (const slot of ['i42', 'i7']) {
    const created = await tmux(
      'new-session',
      '-d',
      '-s',
      `cs-${slot}`,
      '-c',
      join(ws.ws, `.wt-widget-${slot}`),
      'sleep',
      '600',
    );
    expect(created?.code).toBe(0);
  }

  const deps: ControlDeps = {
    exec,
    clock: new FakeClock(),
    watchedProjects: () => [{ id: 'prj_1', root }],
    profiles: () => [profile],
    policy: permissivePolicy,
    tmuxServer: server,
    // C-123: the session runs `exec-run` on its launch file, in the workspace.
    selfCommand: [process.execPath, join(import.meta.dir, '..', 'main.ts')],
    orchestratorDir: join(ws.ws, 'orchestrator'),
  };
  const sessions = async () =>
    ((await tmux('list-sessions', '-F', '#{session_name}'))?.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .sort();
  return {
    root,
    record,
    binary,
    deps,
    sessions,
    tmux,
    ws: ws.ws,
    run: ws.run,
  };
};

describe.skipIf(!tmuxInstalled)('control commands on a real tmux', () => {
  it('starts the orchestrator with exactly D2 argv and the profile env, once', async () => {
    const f = await fixture();
    const target = { projectId: 'prj_1', root: f.root };
    const start = {
      ...target,
      profileId: 'claude-fake',
      model: 'opus',
      permissionMode: 'manual',
      mode: 'start',
    } as const;

    const started = await startOrchestrator(start, f.deps);
    expect(started.session).toBe(SESSION);
    expect(await eventually(() => existsSync(`${f.record}.argv`))).toBe(true);

    // argv as the binary received it: no shell re-split the prompt.
    expect(readFileSync(`${f.record}.argv`, 'utf8').split('\n')).toEqual([
      '--fake-flag',
      '--remote-control',
      SESSION,
      '-n',
      SESSION,
      '--model',
      'opus',
      '--permission-mode',
      'default',
      '/code-sentinel:orchestrator start',
      '',
    ]);
    const env = readFileSync(`${f.record}.env`, 'utf8');
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${join(f.ws, 'profile')}\n`);
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-x\n');
    // C-123: the env reached the binary, but never the tmux argv.
    const panes = await f.tmux(
      'list-panes',
      '-t',
      `=${SESSION}`,
      '-F',
      '#{pane_start_command}',
    );
    expect(panes?.stdout).toContain('exec-run');
    expect(panes?.stdout).not.toContain('sk-ant-x');
    // Started in the project root.
    expect(env).toContain(`PWD=${f.root}\n`);

    await expect(startOrchestrator(start, f.deps)).rejects.toMatchObject({
      code: 'already_running',
    });

    expect(await stopOrchestrator(target, f.deps)).toEqual({ stopped: true });
    expect(await f.sessions()).toEqual(['cs-i42', 'cs-i7']);
    for (const slot of ['i42', 'i7']) {
      expect(existsSync(join(f.ws, `.wt-widget-${slot}`))).toBe(true);
    }
  });

  it('stops cs-i42 only and keeps its worktree, branch and commits', async () => {
    const f = await fixture();
    const wt = join(f.ws, '.wt-widget-i42');
    const head = await f.run(wt, 'rev-parse', 'HEAD');

    expect(
      await stopSlot({ projectId: 'prj_1', root: f.root, slot: 'i42' }, f.deps),
    ).toEqual({ stopped: true });
    expect(await f.sessions()).toEqual(['cs-i7']);
    expect(existsSync(wt)).toBe(true);
    expect(await f.run(wt, 'branch', '--show-current')).toBe('feat/i42');
    expect(await f.run(wt, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('messages a live worker: file written, prompt typed', async () => {
    const f = await fixture();
    expect(
      await messageSlot(
        {
          projectId: 'prj_1',
          root: f.root,
          slot: 'i7',
          text: 'Please rebase.',
          from: 'dev@example.com',
        },
        f.deps,
      ),
    ).toEqual({ written: true, delivered: true });
    expect(
      readFileSync(join(f.ws, '.wt-widget-i7', MESSAGE_FILE), 'utf8'),
    ).toStartWith('From: dev@example.com via Nautelle\n');
  });

  it('messages the orchestrator: file in the git dir, prompt typed, then submitted', async () => {
    const f = await fixture();
    // A stand-in orchestrator: `cat` writes a line to its file only once the
    // line is submitted, so the file proves the C-m reached the pane.
    const typed = join(f.ws, 'typed');
    const created = await f.deps.exec('tmux', [
      ...(f.deps.tmuxServer ?? []),
      'new-session',
      '-d',
      '-s',
      SESSION,
      '-c',
      f.root,
      'sh',
      '-c',
      `cat > '${typed}'`,
    ]);
    expect(created?.code).toBe(0);

    expect(
      await messageOrchestrator(
        {
          projectId: 'prj_1',
          root: f.root,
          body: 'Hold i43.',
          from: 'dev@example.com',
        },
        f.deps,
      ),
    ).toEqual({ delivered: true });

    const dir = join(f.root, '.git', ORCHESTRATOR_MESSAGE_DIR);
    const [name] = readdirSync(dir);
    const file = join(dir, name ?? '');
    expect(readFileSync(file, 'utf8')).toEndWith('\n\nHold i43.\n');
    expect(
      await eventually(
        () =>
          existsSync(typed) &&
          readFileSync(typed, 'utf8') ===
            `${orchestratorMessagePrompt(file)}\n`,
      ),
    ).toBe(true);
    // Inside .git: the checkout stays clean.
    expect(await f.run(f.root, 'status', '--porcelain')).toBe('');
  });
});
