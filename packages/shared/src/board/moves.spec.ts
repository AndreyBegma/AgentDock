import { describe, expect, it } from 'bun:test';
import { type BoardMoveInput, boardMoveRule } from './moves';
import {
  ACTIVE_CARD_ROUND_PHASES,
  BOARD_COLUMNS,
  CARD_ROUND_PHASES,
  isActiveRoundPhase,
} from './types';

const move = (input: Partial<BoardMoveInput>): BoardMoveInput => ({
  from: 'todo',
  to: 'in_progress',
  roundPhase: null,
  source: 'person',
  ...input,
});

const INACTIVE = CARD_ROUND_PHASES.filter((p) => !isActiveRoundPhase(p));

describe('boardMoveRule', () => {
  describe('an active round holds the card in In progress', () => {
    for (const phase of ACTIVE_CARD_ROUND_PHASES) {
      for (const to of ['todo', 'completed'] as const) {
        it(`refuses in_progress → ${to} while ${phase}`, () => {
          expect(
            boardMoveRule(move({ from: 'in_progress', to, roundPhase: phase })),
          ).toEqual({ allowed: false, error: 'card_running' });
        });
      }

      it(`allows in_progress → finished while ${phase}, as Mark finished`, () => {
        expect(
          boardMoveRule(
            move({ from: 'in_progress', to: 'finished', roundPhase: phase }),
          ),
        ).toEqual({
          allowed: true,
          effects: ['finish', 'collect'],
          offerRun: false,
        });
      });

      it(`allows in_progress → todo while ${phase} with stopWorker`, () => {
        expect(
          boardMoveRule(
            move({
              from: 'in_progress',
              to: 'todo',
              roundPhase: phase,
              stopWorker: true,
            }),
          ),
        ).toEqual({ allowed: true, effects: ['stop'], offerRun: false });
      });
    }

    it('stops, then accepts, on in_progress → completed with stopWorker', () => {
      expect(
        boardMoveRule(
          move({
            from: 'in_progress',
            to: 'completed',
            roundPhase: 'running',
            stopWorker: true,
          }),
        ),
      ).toEqual({
        allowed: true,
        effects: ['stop', 'accept'],
        offerRun: false,
      });
    });

    it('refuses an automatic move out of In progress to To Do', () => {
      expect(
        boardMoveRule(
          move({
            from: 'in_progress',
            to: 'todo',
            roundPhase: 'waiting',
            source: 'automatic',
          }),
        ),
      ).toEqual({ allowed: false, error: 'card_running' });
    });

    it('lets Run move a card into In progress with its new round queued', () => {
      expect(
        boardMoveRule(
          move({
            to: 'in_progress',
            roundPhase: 'queued',
            source: 'automatic',
          }),
        ),
      ).toEqual({ allowed: true, effects: [], offerRun: false });
    });

    it('allows reordering inside In progress while running', () => {
      expect(
        boardMoveRule(
          move({
            from: 'in_progress',
            to: 'in_progress',
            roundPhase: 'running',
          }),
        ),
      ).toEqual({ allowed: true, effects: [], offerRun: false });
    });
  });

  describe('a finished or failed round does not hold the card', () => {
    for (const phase of INACTIVE) {
      it(`allows in_progress → todo after ${phase}`, () => {
        expect(
          boardMoveRule(
            move({ from: 'in_progress', to: 'todo', roundPhase: phase }),
          ),
        ).toEqual({ allowed: true, effects: [], offerRun: false });
      });
    }
  });

  describe('automation never completes a card', () => {
    for (const from of BOARD_COLUMNS) {
      for (const roundPhase of [null, ...CARD_ROUND_PHASES]) {
        it(`refuses automatic ${from} → completed (${roundPhase})`, () => {
          expect(
            boardMoveRule(
              move({ from, to: 'completed', roundPhase, source: 'automatic' }),
            ),
          ).toEqual({ allowed: false, error: 'automatic_to_completed' });
        });
      }
    }

    it('never moves a Completed card automatically', () => {
      expect(
        boardMoveRule(
          move({
            from: 'completed',
            to: 'finished',
            roundPhase: 'ended',
            source: 'automatic',
          }),
        ),
      ).toEqual({ allowed: false, error: 'card_completed' });
    });

    it('lets a person accept a Finished card', () => {
      expect(
        boardMoveRule(
          move({ from: 'finished', to: 'completed', roundPhase: 'finished' }),
        ),
      ).toEqual({ allowed: true, effects: ['accept'], offerRun: false });
    });
  });

  describe('Finished', () => {
    it('collects when a card with a round enters Finished', () => {
      expect(
        boardMoveRule(
          move({
            from: 'in_progress',
            to: 'finished',
            roundPhase: 'ended',
            source: 'automatic',
          }),
        ),
      ).toEqual({ allowed: true, effects: ['collect'], offerRun: false });
    });

    it('has nothing to collect for a card that never ran', () => {
      expect(boardMoveRule(move({ from: 'todo', to: 'finished' }))).toEqual({
        allowed: true,
        effects: [],
        offerRun: false,
      });
    });
  });

  describe('Run? on a drop onto In progress', () => {
    it('offers Run for a person dropping a To Do card', () => {
      expect(boardMoveRule(move({ from: 'todo', to: 'in_progress' }))).toEqual({
        allowed: true,
        effects: [],
        offerRun: true,
      });
    });

    it('offers Run for a person dropping a Finished card', () => {
      const decision = boardMoveRule(
        move({ from: 'finished', to: 'in_progress', roundPhase: 'finished' }),
      );
      expect(decision).toEqual({ allowed: true, effects: [], offerRun: true });
    });

    it('does not offer Run from Completed, but reopens', () => {
      expect(
        boardMoveRule(
          move({
            from: 'completed',
            to: 'in_progress',
            roundPhase: 'finished',
          }),
        ),
      ).toEqual({ allowed: true, effects: ['reopen'], offerRun: false });
    });

    it('does not offer Run for an automatic move', () => {
      const decision = boardMoveRule(
        move({ to: 'in_progress', source: 'automatic' }),
      );
      expect(decision.allowed && decision.offerRun).toBe(false);
    });
  });

  it('reopens a Completed card a person moves back', () => {
    expect(
      boardMoveRule(
        move({ from: 'completed', to: 'todo', roundPhase: 'finished' }),
      ),
    ).toEqual({ allowed: true, effects: ['reopen'], offerRun: false });
  });

  describe('Inbox (#244 D9)', () => {
    it('accepts a suggestion a person drags to To Do', () => {
      expect(
        boardMoveRule(move({ from: 'inbox', to: 'todo', roundPhase: null })),
      ).toEqual({
        allowed: true,
        effects: ['accept_suggestion'],
        offerRun: false,
      });
    });

    it('refuses every other move out of the Inbox', () => {
      for (const to of ['in_progress', 'finished', 'completed'] as const) {
        expect(
          boardMoveRule(move({ from: 'inbox', to, roundPhase: null })),
        ).toEqual({ allowed: false, error: 'invalid_move' });
      }
    });

    it('refuses every move into the Inbox, by a person or automation', () => {
      for (const from of [
        'todo',
        'in_progress',
        'finished',
        'completed',
      ] as const) {
        for (const source of ['person', 'automatic'] as const) {
          const decision = boardMoveRule(
            move({ from, to: 'inbox', roundPhase: null, source }),
          );
          // Automation never moves a Completed card, whatever the target.
          const error =
            from === 'completed' && source === 'automatic'
              ? 'card_completed'
              : 'invalid_move';
          expect(decision).toEqual({ allowed: false, error });
        }
      }
    });

    it('never accepts a suggestion automatically', () => {
      expect(
        boardMoveRule(
          move({
            from: 'inbox',
            to: 'todo',
            roundPhase: null,
            source: 'automatic',
          }),
        ),
      ).toEqual({ allowed: false, error: 'invalid_move' });
    });
  });

  it('allows reordering inside a column', () => {
    for (const column of BOARD_COLUMNS) {
      expect(
        boardMoveRule(move({ from: column, to: column, roundPhase: null })),
      ).toEqual({ allowed: true, effects: [], offerRun: false });
    }
  });
});
