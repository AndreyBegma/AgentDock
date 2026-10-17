import { describe, expect, test } from 'bun:test';
import type { PlanTurnView } from '@agentdock/shared';
import { plan, turn } from '../planner/fixtures';
import {
  discussionEntries,
  discussionFailed,
  discussStateText,
  proposalBrief,
  proposalCount,
} from './discuss';

const discussion = (turns: PlanTurnView[], over = {}) =>
  plan({
    mode: 'discuss',
    status: 'clarifying',
    tasks: [],
    brief: 'How are runner tokens checked?',
    turns,
    activeTurnId:
      turns.find((t) => t.phase === 'queued' || t.phase === 'running')?.id ??
      null,
    discussion: { skills: ['cs-security'] },
    ...over,
  });

const replied = (id: string, message?: string, proposals = 0): PlanTurnView =>
  turn({
    id,
    action: 'discuss',
    input: message ? { message } : {},
    reply: {
      reply: `Reply ${id}`,
      proposals: Array.from({ length: proposals }, (_, i) => ({
        title: `Card ${i}`,
        brief: `Brief ${i}`,
      })),
    },
  });

const failed = (id: string, message?: string): PlanTurnView =>
  turn({
    id,
    action: 'discuss',
    input: message ? { message } : {},
    phase: 'failed',
    error: 'contract_violation: invalid_shape: proposals.0.brief',
    reply: null,
  });

describe('discussionEntries', () => {
  test('opens with the brief, then each message and its reply', () => {
    const entries = discussionEntries(
      discussion([replied('a'), replied('b', 'And the index?', 2)]),
    );
    expect(entries.map((e) => e.kind)).toEqual([
      'person',
      'reply',
      'person',
      'reply',
    ]);
    expect(entries[0]).toMatchObject({
      text: 'How are runner tokens checked?',
    });
    expect(entries[2]).toMatchObject({ text: 'And the index?' });
    expect(entries[3]).toMatchObject({ proposals: [{ title: 'Card 0' }, {}] });
  });

  test('reads a retried question once', () => {
    const entries = discussionEntries(
      discussion([
        replied('a'),
        failed('b', 'And the index?'),
        replied('c', 'And the index?'),
      ]),
    );
    expect(
      entries.filter((e) => e.kind === 'person').map((e) => e.text),
    ).toEqual(['How are runner tokens checked?', 'And the index?']);
    expect(entries.some((e) => e.kind === 'unanswered')).toBe(false);
  });

  test('marks a question left behind without a reply', () => {
    const entries = discussionEntries(
      discussion([replied('a'), failed('b', 'First?'), replied('c', 'Other?')]),
    );
    expect(entries.map((e) => e.kind)).toEqual([
      'person',
      'reply',
      'person',
      'unanswered',
      'person',
      'reply',
    ]);
  });

  test('leaves the newest failed turn to the failed state', () => {
    const p = discussion([replied('a'), failed('b', 'Why?')]);
    expect(discussionEntries(p).map((e) => e.kind)).toEqual([
      'person',
      'reply',
      'person',
    ]);
    expect(discussionFailed(p)?.id).toBe('b');
  });
});

describe('discussStateText', () => {
  const now = Date.parse('2026-10-13T10:17:00.000Z');

  test('counts messages and proposals, and says how long ago', () => {
    const p = discussion(
      [replied('a', undefined, 1), replied('b', 'More?', 1)],
      { updatedAt: '2026-10-13T10:05:00.000Z' },
    );
    expect(proposalCount(p)).toBe(2);
    expect(discussStateText(p, now)).toBe(
      '4 messages · 2 cards proposed · 12 min ago',
    );
  });

  test('says when the planner is thinking or failed', () => {
    expect(
      discussStateText(
        discussion([turn({ action: 'discuss', phase: 'running' })]),
        now,
      ),
    ).toBe('Thinking…');
    expect(discussStateText(discussion([failed('a')]), now)).toBe(
      'Failed — retry',
    );
    expect(discussStateText(undefined, now)).toBeNull();
  });
});

test('Make a card prefills the title and the brief', () => {
  expect(
    proposalBrief({ title: 'Rotate tokens', brief: 'Add rotation.' }),
  ).toBe('Rotate tokens\n\nAdd rotation.');
});
