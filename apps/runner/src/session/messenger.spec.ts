import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCodeSentinelLine } from '@nautelle/shared';
import { sessionMessageArgsSchema } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { fakeTmux } from '../control/testing';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { SessionMessenger } from './messenger';

const IDLE = '╭────╮\n│ >  │\n╰────╯\n';
const QUESTION = readFileSync(
  join(import.meta.dir, '..', 'cards', '__fixtures__', 'ask-user-question.txt'),
  'utf8',
);

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

const fleet = (sessions: Record<string, string>) => {
  const git = tempDir();
  cleanup.push(git.cleanup);
  const fake = fakeTmux({
    worktrees: ['/srv/.wt-widget-i42', '/srv/.wt-widget-i7'],
    sessions,
    gitDir: git.dir,
  });
  const messenger = new SessionMessenger({
    exec: fake.deps.exec,
    clock: fake.deps.clock,
    watchedProjects: fake.deps.watchedProjects,
    log: memoryLogger().log,
  });
  const eventsFile = join(git.dir, 'cs-orchestrator', 'events.jsonl');
  const lines = () =>
    existsSync(eventsFile)
      ? readFileSync(eventsFile, 'utf8').trimEnd().split('\n')
      : [];
  return { fake, messenger, lines };
};

const slotArgs = (slot: string, text = 'Rebase on develop first') => ({
  projectId: 'prj_1',
  target: { kind: 'fleet_slot' as const, root: '/srv/widget', slot },
  message: { kind: 'text' as const, text },
});

describe('session.message to a fleet slot (#489 M5)', () => {
  it('types the text into cs-<slot> with an exact target, then Enter apart, and records slot.message_sent by a person', async () => {
    const t = fleet({ 'cs-i42': IDLE, 'cs-i7': IDLE });
    expect(await t.messenger.message(slotArgs('i42'))).toEqual({
      outcome: 'sent',
    });
    expect(t.fake.tmuxCalls().filter((c) => c[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', '=cs-i42:', '-l', 'Rebase on develop first'],
      ['send-keys', '-t', '=cs-i42:', 'C-m'],
    ]);
    const lines = t.lines();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '');
    expect(line).toMatchObject({
      v: 1,
      ts: '2026-10-08T10:00:00.000Z',
      type: 'slot.message_sent',
      slot: 'i42',
      issue: 42,
      project: { repo: 'acme/widget', root: '/srv/widget' },
      data: { slot: 'i42', text: 'Rebase on develop first', by: 'person' },
    });
    expect(line.eid).toMatch(/^agentdock-/);
    // The events collector forwards it like any line the plugin writes.
    const normalized = normalizeCodeSentinelLine(lines[0] ?? '', {
      repo: 'acme/widget',
      root: '/srv/widget',
    });
    expect(normalized.ok).toBe(true);
  });

  it('records nothing when nothing was typed: no session, or a selector up', async () => {
    const t = fleet({ 'cs-i42': QUESTION });
    expect(await t.messenger.message(slotArgs('i42'))).toEqual({
      outcome: 'question',
    });
    expect(await t.messenger.message(slotArgs('i7'))).toEqual({
      outcome: 'no_session',
    });
    expect(t.fake.tmuxCalls().some((c) => c[0] === 'send-keys')).toBe(false);
    expect(t.lines()).toEqual([]);
  });

  it("refuses a slot that is not this project's", async () => {
    const t = fleet({ 'cs-i9': IDLE });
    const error = await t.messenger
      .message(slotArgs('i9'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandFailure);
    expect((error as CommandFailure).code).toBe('path_not_allowed');
  });
});

describe('session.message to a card round', () => {
  it('refuses a card of another project, or a round that is not current', async () => {
    const messenger = new SessionMessenger({
      cards: {
        record: () =>
          ({ cardId: 'card_1', projectId: 'prj_1', runId: 'run_2' }) as never,
        liveSession: () => 'nautelle-card-ab12cd34',
      },
      ...fakeTmux().deps,
      log: memoryLogger().log,
    });
    const send = (projectId: string, runId: string) =>
      messenger
        .message({
          projectId,
          target: { kind: 'card_round', cardId: 'card_1', runId },
          message: { kind: 'text', text: 'hi' },
        })
        .catch((e: unknown) => (e as CommandFailure).code);
    expect(await send('prj_2', 'run_2')).toBe('not_found');
    expect(await send('prj_1', 'run_1')).toBe('not_found');
  });
});

describe('the args schema (M1)', () => {
  it('refuses text with control characters or escape sequences before any handler runs', () => {
    for (const text of ['a\u001b[Ab', 'line\nbreak', 'x\u0003']) {
      expect(
        sessionMessageArgsSchema.safeParse(slotArgs('i42', text)).success,
      ).toBe(false);
    }
    expect(
      sessionMessageArgsSchema.safeParse({
        ...slotArgs('i42'),
        target: {
          kind: 'fleet_slot',
          root: '/srv/widget',
          slot: 'i42',
          session: 'x',
        },
      }).success,
    ).toBe(false);
  });
});
