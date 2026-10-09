import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigProfile } from '../config';
import { createExec, type Exec } from '../detect/exec';
import { FakeClock } from '../testing/fake-clock';
import { workspace } from '../testing/projects';
import type { ControlDeps } from './deps';
import { startOrchestrator, stopOrchestrator } from './orchestrator';
import { MESSAGE_FILE, messageSlot, stopSlot } from './slot';

/**
 * Spec 17's acceptance criteria against a real tmux. The server is private
 * (`tmux -L <name>`): the user's own server — where live fleets run — is
 * never listed, let alone touched.
 */
const tmuxInstalled = Bun.which('tmux') !== null;
const SESSION = 'agentdock-orch-acme-widget';

let ws: ReturnType<typeof workspace> | undefined;
let killServer: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await killServer?.();
  ws?.cleanup();
});

/** Polls `check` every 25 ms for up to 5 s. */
const eventually = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(25);
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

  // The profile's binary: records its argv (one per line) and env, then sleeps.
  const record = join(ws.ws, 'record');
  const binary = join(ws.ws, 'fake-claude');
  writeFileSync(
    binary,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RECORD.argv"\nenv > "$RECORD.env"\nexec sleep 600\n',
  );
  chmodSync(binary, 0o755);
  const profile: ConfigProfile = {
    id: 'claude-fake',
    runtime: 'claude',
    binary,
    env: { CLAUDE_CONFIG_DIR: join(ws.ws, 'profile'), RECORD: record },
    args: ['--fake-flag'],
  };

  const server = ['-L', `agentdock-test-${process.pid}-${Date.now()}`];
  const tmuxExec = createExec({ PATH: process.env.PATH, HOME: ws.ws });
  const tmux = (...args: string[]) => tmuxExec('tmux', [...server, ...args]);
  killServer = () => tmux('kill-server');
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
    tmuxServer: server,
  };
  const sessions = async () =>
    ((await tmux('list-sessions', '-F', '#{session_name}'))?.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .sort();
  return { root, record, binary, deps, sessions, ws: ws.ws, run: ws.run };
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
    expect(await eventually(() => existsSync(`${f.record}.env`))).toBe(true);

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
    ).toStartWith('From: dev@example.com via AgentDock\n');
  });
});
