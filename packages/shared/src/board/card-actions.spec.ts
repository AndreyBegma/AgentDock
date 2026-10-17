import { describe, expect, it } from 'bun:test';
import { cardReviewActions } from './card-actions';
import type { CardRoundBrief } from './contracts';
import type { CardRoundPhase } from './types';

type Card = Parameters<typeof cardReviewActions>[0];

const round = (phase: CardRoundPhase) =>
  ({ round: 1, phase }) as unknown as CardRoundBrief;

const card = (extra: Partial<Card> = {}): Card => ({
  column: 'finished',
  round: round('finished'),
  source: 'manual',
  tracking: null,
  fleet: null,
  branch: 'agentdock/c-1',
  prUrl: 'https://github.com/acme/widget/pull/7',
  collectState: 'ok',
  collectError: null,
  ...extra,
});

describe('cardReviewActions (#578)', () => {
  it('a Finished card is accepted or sent back with feedback', () => {
    expect(cardReviewActions(card())).toEqual(['accept', 'feedback']);
  });

  it('a Finished card without a pull request also offers Create pull request', () => {
    expect(cardReviewActions(card({ prUrl: null }))).toEqual([
      'accept',
      'feedback',
      'collect',
    ]);
    expect(
      cardReviewActions(card({ prUrl: null, collectState: 'pending' })),
    ).toEqual(['accept', 'feedback']);
    expect(
      cardReviewActions(
        card({
          prUrl: null,
          collectState: 'failed',
          collectError: 'card x not found on the runner: it has no worktree',
        }),
      ),
    ).toEqual(['accept', 'feedback']);
  });

  it('a running card is messaged or marked finished', () => {
    expect(
      cardReviewActions(
        card({ column: 'in_progress', round: round('running') }),
      ),
    ).toEqual(['message', 'finish']);
  });

  it("a fleet card's worker is messaged through its slot, never finished here", () => {
    const fleet = {
      issue: 41,
      slot: 'slot-2',
      stage: null,
      slotGone: false,
    };
    expect(
      cardReviewActions(
        card({ source: 'fleet', column: 'in_progress', round: null, fleet }),
      ),
    ).toEqual(['message']);
    expect(
      cardReviewActions(
        card({
          source: 'fleet',
          column: 'in_progress',
          round: null,
          fleet: { ...fleet, slotGone: true },
        }),
      ),
    ).toEqual([]);
    // Accepted like any card; feedback is the orchestrator's.
    expect(
      cardReviewActions(card({ source: 'fleet', round: null, fleet })),
    ).toEqual(['accept']);
  });

  it('an Inbox card is accepted or dismissed, nothing else', () => {
    expect(cardReviewActions(card({ column: 'inbox', round: null }))).toEqual([
      'accept_suggestion',
      'dismiss',
    ]);
  });

  it('To do and Completed offer no review action', () => {
    expect(cardReviewActions(card({ column: 'todo', round: null }))).toEqual(
      [],
    );
    expect(cardReviewActions(card({ column: 'completed' }))).toEqual([]);
  });
});
