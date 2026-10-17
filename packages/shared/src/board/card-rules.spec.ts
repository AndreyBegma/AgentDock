import { describe, expect, it } from 'bun:test';
import {
  BOARD_ACTION_ERROR_TEXT,
  canRetry,
  canRun,
  canStop,
  MOVE_REFUSAL_TEXT,
} from './card-rules';
import { BOARD_ERROR } from './contracts';
import { boardMoveRule } from './moves';
import { BOARD_COLUMNS, CARD_ROUND_PHASES } from './types';

type RuleCard = Parameters<typeof canRun>[0];

const card = (over: Partial<RuleCard> = {}): RuleCard => ({
  source: 'manual',
  tracking: null,
  column: 'todo',
  round: null,
  design: null,
  ...over,
});
const round = (phase: (typeof CARD_ROUND_PHASES)[number]) =>
  ({ round: 1, phase }) as RuleCard['round'];

describe('card action rules', () => {
  it('Run: a manual card in To Do or Finished with no active round', () => {
    expect(canRun(card())).toBe(true);
    expect(canRun(card({ column: 'finished', round: round('finished') }))).toBe(
      true,
    );
    expect(canRun(card({ column: 'inbox' }))).toBe(false);
    expect(canRun(card({ column: 'completed' }))).toBe(false);
    expect(canRun(card({ round: round('running') }))).toBe(false);
  });

  it('Run is not offered for a fleet card, a live terminal session or an unapproved design', () => {
    expect(canRun(card({ source: 'fleet' }))).toBe(false);
    expect(
      canRun(
        card({
          source: 'terminal',
          tracking: { alive: true } as RuleCard['tracking'],
        }),
      ),
    ).toBe(false);
    expect(
      canRun(
        card({
          design: { needed: true, status: 'reviewing' } as RuleCard['design'],
        }),
      ),
    ).toBe(false);
  });

  it('Retry: an In progress card whose round is no longer active', () => {
    expect(
      canRetry(card({ column: 'in_progress', round: round('cancelled') })),
    ).toBe(true);
    expect(
      canRetry(card({ column: 'in_progress', round: round('running') })),
    ).toBe(false);
    expect(canRetry(card({ column: 'in_progress' }))).toBe(false);
  });

  it('Stop: only while a round is active', () => {
    for (const phase of CARD_ROUND_PHASES) {
      const active = ['queued', 'starting', 'running', 'waiting', 'background'];
      expect(canStop(card({ round: round(phase) }))).toBe(
        active.includes(phase),
      );
    }
    expect(canStop(card({ source: 'fleet', round: round('running') }))).toBe(
      false,
    );
  });

  it('words every refusal of the move rule', () => {
    for (const column of BOARD_COLUMNS) {
      const decision = boardMoveRule({
        from: 'completed',
        to: column,
        roundPhase: null,
        source: 'automatic',
      });
      if (!decision.allowed) {
        expect(MOVE_REFUSAL_TEXT[decision.error]).toBeTruthy();
      }
    }
    expect(BOARD_ACTION_ERROR_TEXT[BOARD_ERROR.cardRunning]).toBeTruthy();
  });
});
