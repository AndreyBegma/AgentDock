import { describe, expect, it } from 'bun:test';
import { STEWARD_NUDGE_TEXT } from '../../steward/contracts';
import { isCommandName } from '../commands';
import {
  cardResumeArgsSchema,
  cardResumeResultSchema,
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
        tmuxSession: 'agentdock-card-abcd1234',
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
