import {
  STEWARD_DEFAULTS,
  STEWARD_NUDGE_REPEAT_DELAY_MS,
  type StewardActionRecord,
} from '@agentdock/shared';
import { nextStep, PENDING_DETAIL, type PolicyInput } from './steward-policy';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const record = (
  action: StewardActionRecord['action'],
  at = ago(10 * 60_000),
  extra: Partial<StewardActionRecord> = {},
): StewardActionRecord => ({ action, at, result: 'ok', ...extra });

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  subjectKind: 'card_round',
  kind: 'api_error',
  actions: [],
  roundActions: [],
  settings: STEWARD_DEFAULTS,
  dialogId: null,
  now: NOW,
  ...over,
});

describe('nextStep (#447 D4, D9–D11)', () => {
  describe('an API error (D9)', () => {
    it('nudges at once the first time', () => {
      expect(nextStep(input())).toEqual({ step: 'nudge' });
    });

    it('waits 2 minutes after the first nudge, then nudges again', () => {
      const first = record('nudge', ago(30_000));
      expect(nextStep(input({ roundActions: [first] }))).toEqual({
        step: 'wait',
        until: new Date(Date.parse(first.at) + STEWARD_NUDGE_REPEAT_DELAY_MS),
      });
      const older = record('nudge', ago(STEWARD_NUDGE_REPEAT_DELAY_MS));
      expect(nextStep(input({ roundActions: [older] }))).toEqual({
        step: 'nudge',
      });
    });

    it('escalates the third error — the limit is per round, across incidents', () => {
      const both = [record('nudge'), record('nudge', ago(5 * 60_000))];
      expect(nextStep(input({ roundActions: both }))).toEqual({
        step: 'escalate',
      });
    });

    it('a failed nudge counts as an attempt', () => {
      const both = [
        record('nudge', ago(9 * 60_000), { result: 'failed' }),
        record('nudge', ago(5 * 60_000), { result: 'failed' }),
      ];
      expect(nextStep(input({ roundActions: both })).step).toBe('escalate');
    });

    it('escalates instead when nudging is switched off', () => {
      const settings = { ...STEWARD_DEFAULTS, autoNudge: false };
      expect(nextStep(input({ settings })).step).toBe('escalate');
    });

    it('waits while an attempt is unanswered', () => {
      const sent = record('nudge', ago(1_000), {
        result: 'failed',
        detail: PENDING_DETAIL,
      });
      expect(
        nextStep(input({ actions: [sent], roundActions: [sent] })),
      ).toEqual({ step: 'wait', until: null });
    });
  });

  describe('a dialog (D11)', () => {
    it('dismisses a listed dialog once', () => {
      const dialog = input({ kind: 'dialog', dialogId: 'teach-auto-mode' });
      expect(nextStep(dialog)).toEqual({
        step: 'dismiss',
        dialogId: 'teach-auto-mode',
      });
      expect(nextStep({ ...dialog, actions: [record('dismiss')] }).step).toBe(
        'escalate',
      );
    });

    it('never answers an unknown dialog or a permission prompt', () => {
      expect(nextStep(input({ kind: 'dialog' })).step).toBe('escalate');
      expect(nextStep(input({ kind: 'permission_prompt' })).step).toBe(
        'escalate',
      );
    });

    it('escalates when dismissing is switched off', () => {
      const settings = { ...STEWARD_DEFAULTS, autoDismiss: false };
      expect(
        nextStep(
          input({ kind: 'dialog', dialogId: 'teach-auto-mode', settings }),
        ).step,
      ).toBe('escalate');
    });
  });

  describe('a dead session (D10)', () => {
    it('resumes at most twice per round', () => {
      const dead = input({ kind: 'dead_session' });
      expect(nextStep(dead)).toEqual({ step: 'resume' });
      expect(nextStep({ ...dead, roundActions: [record('resume')] }).step).toBe(
        'resume',
      );
      expect(
        nextStep({
          ...dead,
          roundActions: [record('resume'), record('resume')],
        }).step,
      ).toBe('escalate');
    });

    it('resumes only a card round, and only with the switch on', () => {
      expect(
        nextStep(input({ kind: 'dead_session', subjectKind: 'run' })).step,
      ).toBe('escalate');
      const settings = { ...STEWARD_DEFAULTS, autoResume: false };
      expect(nextStep(input({ kind: 'dead_session', settings })).step).toBe(
        'escalate',
      );
    });
  });

  it('only escalates silence, quota and an unknown stall', () => {
    for (const kind of ['silent', 'quota', 'unknown'] as const) {
      expect(nextStep(input({ kind })).step).toBe('escalate');
    }
  });

  it('leaves a held push to the runner', () => {
    expect(nextStep(input({ kind: 'trailer' })).step).toBe('none');
  });

  it('never acts on a fleet slot (D5)', () => {
    for (const kind of ['api_error', 'dialog', 'dead_session'] as const) {
      expect(
        nextStep(
          input({
            kind,
            subjectKind: 'fleet_slot',
            dialogId: 'teach-auto-mode',
          }),
        ).step,
      ).toBe('escalate');
    }
  });
});
