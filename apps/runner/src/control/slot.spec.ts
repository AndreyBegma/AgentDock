import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createDispatcher } from '../commands/dispatcher';
import { createHandlers } from '../commands/handlers';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import {
  MESSAGE_FILE,
  MESSAGE_PROMPT,
  messageSlot,
  stopSlot,
  writeAtomically,
} from './slot';
import { fakeTmux } from './testing';

const root = '/srv/widget';
const target = { projectId: 'prj_1', root };

describe('slot.stop', () => {
  it('kills cs-i42 only, with an exact target', async () => {
    const fake = fakeTmux({
      worktrees: ['/srv/.wt-widget-i42', '/srv/.wt-widget-i7'],
      sessions: { 'cs-i42': '', 'cs-i7': '', 'agentdock-orch-acme-widget': '' },
    });
    expect(await stopSlot({ ...target, slot: 'i42' }, fake.deps)).toEqual({
      stopped: true,
    });
    expect(fake.tmuxCalls().filter((c) => c[0] === 'kill-session')).toEqual([
      ['kill-session', '-t', '=cs-i42'],
    ]);
    expect([...fake.sessions.keys()]).toEqual([
      'cs-i7',
      'agentdock-orch-acme-widget',
    ]);
    // git is only read: no worktree removal, prune or branch deletion.
    for (const call of fake.calls.filter((c) => c[0] === 'git')) {
      for (const verb of ['remove', 'prune', '-d', '-D', 'checkout']) {
        expect(call).not.toContain(verb);
      }
    }
  });

  it('never prefix-matches: stopping i4 while only cs-i42 lives kills nothing', async () => {
    const fake = fakeTmux({
      worktrees: ['/srv/.wt-widget-i4', '/srv/.wt-widget-i42'],
      sessions: { 'cs-i42': '' },
    });
    expect(await stopSlot({ ...target, slot: 'i4' }, fake.deps)).toEqual({
      stopped: false,
    });
    expect(fake.tmuxCalls().some((c) => c[0] === 'kill-session')).toBe(false);
    expect(fake.sessions.has('cs-i42')).toBe(true);
  });

  it("kills this repository's prefixed session, never another repository's", async () => {
    const fake = fakeTmux({
      worktrees: ['/srv/.wt-widget-i42'],
      sessions: { 'cs-widget--i42': '', 'cs-other--i42': '' },
    });
    expect(await stopSlot({ ...target, slot: 'i42' }, fake.deps)).toEqual({
      stopped: true,
    });
    expect([...fake.sessions.keys()]).toEqual(['cs-other--i42']);
  });

  it("refuses a slot whose worktree is another project's", async () => {
    // `.wt-gadget-i42` is the gadget project's; widget has no `i42`.
    const fake = fakeTmux({
      worktrees: ['/srv/.wt-widget-i7'],
      sessions: { 'cs-i42': '' },
    });
    await expect(
      stopSlot({ ...target, slot: 'i42' }, fake.deps),
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
    expect(fake.tmuxCalls()).toEqual([]);
  });

  it('refuses a root that is not that project in the watch list', async () => {
    const fake = fakeTmux({ worktrees: ['/srv/.wt-gadget-i42'] });
    await expect(
      stopSlot(
        { projectId: 'prj_1', root: '/srv/gadget', slot: 'i42' },
        fake.deps,
      ),
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
    expect(fake.calls).toEqual([]);
  });
});

describe('slot.message', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  const workspace = () => {
    const dir = tempDir();
    cleanup = dir.cleanup;
    const ws = realpathSync(dir.dir);
    const wt = join(ws, '.wt-widget-i42');
    mkdirSync(wt);
    return { ws, root: join(ws, 'widget'), wt };
  };

  const message = (projectRoot: string) => ({
    projectId: 'prj_1',
    root: projectRoot,
    slot: 'i42',
    text: 'Rebase on develop, then rerun the checks.',
    from: 'dev@example.com',
  });

  it('writes the file with the From header, then sends -l text and Enter as two calls', async () => {
    const { root: projectRoot, wt } = workspace();
    const fake = fakeTmux({
      project: { id: 'prj_1', root: projectRoot },
      worktrees: [wt],
      sessions: { 'cs-i42': '' },
    });

    expect(await messageSlot(message(projectRoot), fake.deps)).toEqual({
      written: true,
      delivered: true,
    });
    expect(readFileSync(join(wt, MESSAGE_FILE), 'utf8')).toBe(
      'From: dev@example.com via AgentDock\n' +
        'Date: 2026-10-08T10:00:00.000Z\n' +
        '\n' +
        'Rebase on develop, then rerun the checks.\n',
    );
    expect(fake.tmuxCalls().filter((c) => c[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', '=cs-i42:', '-l', MESSAGE_PROMPT],
      ['send-keys', '-t', '=cs-i42:', 'Enter'],
    ]);
    // Nothing but the message file is left behind.
    expect(readdirSync(wt)).toEqual([MESSAGE_FILE]);
  });

  it('writes the file but reports undelivered when the session is gone', async () => {
    const { root: projectRoot, wt } = workspace();
    const fake = fakeTmux({
      project: { id: 'prj_1', root: projectRoot },
      worktrees: [wt],
    });
    expect(await messageSlot(message(projectRoot), fake.deps)).toEqual({
      written: true,
      delivered: false,
    });
    expect(existsSync(join(wt, MESSAGE_FILE))).toBe(true);
    expect(fake.tmuxCalls().some((c) => c[0] === 'send-keys')).toBe(false);
  });

  it('replaces a symlink at the message path instead of writing through it', async () => {
    const { ws, root: projectRoot, wt } = workspace();
    const outside = join(ws, 'outside.txt');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, join(wt, MESSAGE_FILE));
    const fake = fakeTmux({
      project: { id: 'prj_1', root: projectRoot },
      worktrees: [wt],
    });
    await messageSlot(message(projectRoot), fake.deps);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(lstatSync(join(wt, MESSAGE_FILE)).isSymbolicLink()).toBe(false);
  });

  it('leaves no temp file when the rename fails', async () => {
    const { wt } = workspace();
    // A directory at the target makes rename fail.
    mkdirSync(join(wt, MESSAGE_FILE));
    await expect(
      writeAtomically(join(wt, MESSAGE_FILE), 'x'),
    ).rejects.toThrow();
    expect(readdirSync(wt)).toEqual([MESSAGE_FILE]);
  });
});

describe('slot commands through the dispatcher', () => {
  it('rejects a slot with /, .. or uppercase as invalid_args before anything runs', async () => {
    const fake = fakeTmux({ worktrees: ['/srv/.wt-widget-i42'] });
    const clock = new FakeClock();
    const dispatch = createDispatcher({
      handlers: createHandlers({
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
    for (const slot of ['../i42', 'a/b', '..', 'I42', '-i42']) {
      for (const [name, extra] of [
        ['slot.stop', {}],
        ['slot.message', { text: 'hi', from: 'dev@example.com' }],
      ] as const) {
        const result = await dispatch({
          type: 'command',
          id: 'c1',
          name,
          args: { ...target, slot, ...extra },
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'invalid_args' },
        });
      }
    }
    expect(fake.calls).toEqual([]);
  });
});
