import { describe, expect, it } from 'bun:test';
import { STEWARD_NUDGE_TEXT } from '../../steward/contracts';
import { isCommandName } from '../commands';
import {
  cardResumeArgsSchema,
  cardResumeResultSchema,
  DIGEST_COMPOSE_ITEMS_MAX,
  digestComposeArgsSchema,
  digestComposeResultSchema,
  STEWARD_COMMAND_NAMES,
  sessionDismissArgsSchema,
  sessionNudgeArgsSchema,
  stewardCommands,
} from './steward';

const subject = { kind: 'card_round', cardId: 'cmcard01', runId: 'cmrun001' };

describe('session.nudge (#447 D9)', () => {
  const args = { projectId: 'p1', subject, text: STEWARD_NUDGE_TEXT };

  it('takes the fixed text only', () => {
    expect(sessionNudgeArgsSchema.safeParse(args).success).toBe(true);
    expect(
      sessionNudgeArgsSchema.safeParse({ ...args, text: 'rm -rf /' }).success,
    ).toBe(false);
  });

  it('never takes a fleet slot (D5)', () => {
    expect(
      sessionNudgeArgsSchema.safeParse({
        ...args,
        subject: { kind: 'fleet_slot', slot: 'i1' },
      }).success,
    ).toBe(false);
    expect(
      sessionNudgeArgsSchema.safeParse({
        ...args,
        subject: { kind: 'run', runId: 'cmrun002' },
      }).success,
    ).toBe(true);
  });
});

describe('session.dismiss (D11)', () => {
  it('takes a dialog on the #435 list only', () => {
    const args = { projectId: 'p1', subject, dialogId: 'teach-auto-mode' };
    expect(sessionDismissArgsSchema.safeParse(args).success).toBe(true);
    expect(
      sessionDismissArgsSchema.safeParse({ ...args, dialogId: 'permission' })
        .success,
    ).toBe(false);
  });
});

describe('card.resume (D10)', () => {
  const args = {
    cardId: 'cmcard01',
    projectId: 'p1',
    runId: 'cmrun001',
    root: '/srv/repo',
    base: 'develop',
    shortId: 'abcd1234',
    branch: 'card/c-12',
    sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    profileKey: 'default',
    model: 'opus',
    permissionMode: 'auto',
  };

  it('takes the round launch facts and nothing the runner would trust as a path', () => {
    const parsed = cardResumeArgsSchema.safeParse(args);
    if (!parsed.success) throw parsed.error;
    expect(
      cardResumeArgsSchema.safeParse({ ...args, root: 'srv/repo' }).success,
    ).toBe(false);
    expect(
      cardResumeArgsSchema.safeParse({ ...args, worktree: '/tmp/x' }).success,
    ).toBe(false);
  });

  it('refuses a pushed branch that is the base', () => {
    expect(
      cardResumeArgsSchema.safeParse({
        ...args,
        branch: 'develop',
        pullRequest: { title: 'C-12: x', body: '' },
      }).success,
    ).toBe(false);
  });

  it('reports a session only when there is one', () => {
    expect(
      cardResumeResultSchema.safeParse({
        outcome: 'resumed',
        tmuxSession: 'nautelle-card-abcd1234',
      }).success,
    ).toBe(true);
    expect(
      cardResumeResultSchema.safeParse({ outcome: 'no_worktree' }).success,
    ).toBe(true);
    expect(
      cardResumeResultSchema.safeParse({ outcome: 'resumed' }).success,
    ).toBe(false);
  });
});

describe('digest.compose (#491)', () => {
  const item = { label: 'C-12', title: 'Fix the login', reason: null };
  const section = (n: number) => ({
    total: n,
    items: Array.from({ length: n }, () => item),
  });
  const args = {
    runId: 'cmrun003',
    projectId: 'p1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    profileKey: 'default',
    model: 'haiku',
    trigger: 'daily',
    projectName: 'Nautelle',
    done: section(2),
    stuck: {
      total: 1,
      items: [{ ...item, reason: 'a test run hung on the database' }],
    },
    waiting: section(0),
    spendUsd: '3.20',
  };

  it('takes the bounded digest content', () => {
    expect(digestComposeArgsSchema.safeParse(args).success).toBe(true);
  });

  it('refuses a second line, an overlong line and extra fields (DA-12, DA-13)', () => {
    const bad = (patch: object) =>
      digestComposeArgsSchema.safeParse({ ...args, ...patch }).success;
    expect(
      bad({
        stuck: {
          total: 1,
          items: [{ ...item, reason: 'line one\n> pane text' }],
        },
      }),
    ).toBe(false);
    expect(
      bad({ done: { total: 1, items: [{ ...item, title: 'x'.repeat(121) }] } }),
    ).toBe(false);
    expect(
      bad({ done: { total: 1, items: [{ ...item, tail: '$ ls' }] } }),
    ).toBe(false);
    expect(bad({ paneTail: 'raw' })).toBe(false);
    expect(bad({ model: 'opus' })).toBe(false);
    expect(bad({ spendUsd: '1e9' })).toBe(false);
  });

  it('bounds how many lines go to the model', () => {
    const many = DIGEST_COMPOSE_ITEMS_MAX + 1;
    expect(
      digestComposeArgsSchema.safeParse({ ...args, done: section(many) })
        .success,
    ).toBe(false);
    expect(
      digestComposeArgsSchema.safeParse({
        ...args,
        done: { total: 1, items: [item, item] },
      }).success,
    ).toBe(false);
  });

  it('answers one bounded line', () => {
    const ok = (prose: string) =>
      digestComposeResultSchema.safeParse({ prose }).success;
    expect(ok('Two cards merged; one is stuck on its tests.')).toBe(true);
    expect(ok('one\ntwo')).toBe(false);
    expect(ok('')).toBe(false);
    expect(ok('x'.repeat(601))).toBe(false);
  });
});

describe('stewardCommands', () => {
  it('needs an operator for every action', () => {
    for (const name of STEWARD_COMMAND_NAMES) {
      expect(stewardCommands[name].minRole).toBe('operator');
    }
  });

  it("is allowlisted, with the runner's handlers", () => {
    // Entered together with the runner's handlers (the card/text precedent).
    for (const name of STEWARD_COMMAND_NAMES) {
      expect(isCommandName(name)).toBe(true);
    }
  });
});
