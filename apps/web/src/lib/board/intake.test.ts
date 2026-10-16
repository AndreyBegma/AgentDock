import { describe, expect, test } from 'bun:test';
import type { PlanIntakeSplitView, PlanSummary } from '@agentdock/shared';
import { plan, question, turn } from '../planner/fixtures';
import { boardView, card } from './fixtures';
import {
  cardsOfPlan,
  confirmSplitCards,
  confirmSplitText,
  draftStateText,
  intakePhase,
  openDrafts,
  roundText,
  splitRowProblem,
  splitRows,
} from './intake';

const intake = (over: Parameters<typeof plan>[0] = {}) =>
  plan({
    mode: 'card',
    status: 'clarifying',
    tasks: [],
    contractVersion: 3,
    intake: { roundsAsked: 1, maxRounds: 4 },
    turns: [turn({ action: 'intake' })],
    ...over,
  });

describe('where a New work intake stands (#337 D2–D6)', () => {
  test('a running turn is thinking', () => {
    const running = turn({ id: 'turn-2', action: 'intake', phase: 'running' });
    const phase = intakePhase(
      intake({ turns: [turn(), running], activeTurnId: 'turn-2' }),
    );
    expect(phase.kind).toBe('thinking');
    expect(
      draftStateText(intake({ turns: [running], activeTurnId: 'turn-2' })),
    ).toBe('thinking…');
  });

  test('an open round says which of at most four, and how many questions wait', () => {
    const p = intake({
      questions: [question(), question({ id: 'q2' })],
      intake: { roundsAsked: 2, maxRounds: 4 },
    });
    expect(intakePhase(p)).toEqual({ kind: 'round', round: 2, maxRounds: 4 });
    expect(roundText(2, 4)).toBe('Round 2 of at most 4');
    expect(draftStateText(p)).toBe('2 questions waiting');
  });

  test('a failed last turn asks for a retry', () => {
    const p = intake({
      turns: [turn({ action: 'intake', phase: 'failed', error: 'boom' })],
    });
    expect(intakePhase(p).kind).toBe('failed');
    expect(draftStateText(p)).toBe('failed — retry');
  });

  test('done finds the generated card on the board by its planId', () => {
    const made = card(12, 'todo', { planId: 'plan-1' });
    const board = boardView([card(3, 'todo'), made]);
    expect(intakePhase(intake({ status: 'done' }), board)).toEqual({
      kind: 'done',
      cards: [made],
    });
    expect(cardsOfPlan(board, 'other')).toEqual([]);
    // Before the board refetch shows it, the card is not known yet.
    expect(intakePhase(intake({ status: 'done' }))).toEqual({
      kind: 'done',
      cards: [],
    });
  });

  test('a single clear task has no split proposal: done with one card (#409)', () => {
    const p = intake({ intake: { roundsAsked: 0, maxRounds: 4, split: null } });
    expect(intakePhase(p).kind).toBe('idle');
  });

  test('a discarded intake is closed', () => {
    expect(intakePhase(intake({ status: 'archived' })).kind).toBe('closed');
  });
});

describe('a split proposal (#409)', () => {
  const split: PlanIntakeSplitView = {
    turnId: 'turn-1',
    reason: 'Это две независимые задачи.',
    cards: [
      {
        index: 0,
        title: 'Export the board as CSV',
        kind: 'feature',
        summary: 'A CSV export from the board menu.',
      },
      {
        index: 1,
        title: 'Fix the sign-in button on mobile',
        kind: 'bug',
        summary: 'The button does nothing on a phone.',
      },
    ],
  };
  const proposing = intake({
    intake: { roundsAsked: 1, maxRounds: 4, split },
  });

  test('is its own phase, and the Drafts strip says so', () => {
    expect(intakePhase(proposing)).toEqual({ kind: 'split', split });
    expect(draftStateText(proposing)).toBe('split into 2 cards?');
  });

  test('a running Keep one card or a failed turn comes first', () => {
    const running = turn({ id: 'turn-2', action: 'intake', phase: 'running' });
    expect(
      intakePhase({
        ...proposing,
        turns: [turn(), running],
        activeTurnId: 'turn-2',
      }).kind,
    ).toBe('thinking');
    expect(
      intakePhase({
        ...proposing,
        turns: [turn({ action: 'intake', phase: 'failed', error: 'x' })],
      }).kind,
    ).toBe('failed');
  });

  test('the rows the person edits become Confirm’s cards, in their order', () => {
    const rows = splitRows(split);
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    const edited = [
      { ...rows[1], title: '  Fix mobile sign-in ', kind: 'feature' as const },
    ];
    expect(confirmSplitCards(edited)).toEqual([
      { index: 1, title: 'Fix mobile sign-in', kind: 'feature' },
    ]);
    // Editing a row leaves the proposal as it was.
    expect(split.cards[1].title).toBe('Fix the sign-in button on mobile');
    expect(confirmSplitText(1)).toBe('Create 1 card');
    expect(confirmSplitText(3)).toBe('Create 3 cards');
  });

  test('a row needs an English title of at most 80 characters', () => {
    expect(splitRowProblem({ title: 'Fix login' })).toBeNull();
    expect(splitRowProblem({ title: '   ' })).toBe('A card needs a title.');
    expect(splitRowProblem({ title: 'x'.repeat(81) })).toBe(
      'At most 80 characters.',
    );
    expect(splitRowProblem({ title: 'Починить вход' })).toContain('English');
  });

  test('done lists every card of the confirmed split', () => {
    const a = card(7, 'todo', { planId: 'plan-1' });
    const b = card(5, 'todo', { planId: 'plan-1' });
    expect(
      intakePhase(
        intake({ status: 'done' }),
        boardView([a, card(2, 'todo'), b]),
      ),
    ).toEqual({ kind: 'done', cards: [b, a] });
  });
});

describe('the Drafts strip (#337 D2)', () => {
  const summary = (
    id: string,
    over: Partial<PlanSummary> = {},
  ): PlanSummary => ({
    id,
    projectId: 'p1',
    title: id,
    author: { id: 'u1', name: 'Ada' },
    mode: 'card',
    visibility: 'private',
    status: 'clarifying',
    version: 1,
    taskCounts: {},
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    sentAt: null,
    ...over,
  });

  test('lists the caller’s own open intakes and plans, newest first', () => {
    const drafts = openDrafts(
      [
        summary('old', { updatedAt: '2026-10-15T09:00:00.000Z' }),
        summary('new', { updatedAt: '2026-10-15T11:00:00.000Z' }),
        summary('plan', { mode: 'dialogue', status: 'reviewing' }),
        summary('made', { status: 'done' }),
        summary('gone', { status: 'archived' }),
        summary('sent', { mode: 'batch', status: 'sent' }),
        summary('theirs', { author: { id: 'u2', name: 'Bo' } }),
      ],
      'u1',
    );
    expect(drafts.map((d) => d.id)).toEqual(['new', 'plan', 'old']);
  });

  test('a plan draft says how far it got', () => {
    expect(draftStateText(plan({ mode: 'dialogue' }))).toBe('3 tasks');
    expect(draftStateText(undefined)).toBeNull();
  });
});
