import { describe, expect, test } from 'bun:test';
import type { BoardAskHit, BoardAskQuery } from '@agentdock/shared';
import { ApiError } from '../api';
import { answerParts, askNotice, queryChips, withoutChip } from './answer';

const card: BoardAskHit = {
  type: 'card',
  projectId: 'p1',
  projectName: 'Nautelle',
  number: 12,
  label: 'C-12',
  title: 'Digest arrives twice',
  column: 'finished',
  kind: 'bug',
  prNumber: 34,
  prUrl: 'https://github.com/acme/agentdock/pull/34',
};

const everything: BoardAskQuery = {
  projects: [],
  text: [],
  columns: [],
  kind: null,
  prState: null,
  checks: null,
  withinDays: null,
  sources: ['cards', 'prs', 'activity'],
};

describe('answerParts', () => {
  test('links the cards and PRs that were found', () => {
    expect(answerParts('See [C-12] and [PR #34].', [card])).toEqual([
      { type: 'text', text: 'See ' },
      {
        type: 'link',
        text: 'C-12',
        href: '/projects/p1/board?card=12',
        external: false,
      },
      { type: 'text', text: ' and ' },
      {
        type: 'link',
        text: 'PR #34',
        href: 'https://github.com/acme/agentdock/pull/34',
        external: true,
      },
      { type: 'text', text: '.' },
    ]);
  });

  test('leaves a reference to nothing found as text', () => {
    expect(answerParts('Нашлась [C-99].', [card])).toEqual([
      { type: 'text', text: 'Нашлась [C-99].' },
    ]);
  });
});

describe('queryChips', () => {
  test('a query that narrows nothing has no chips', () => {
    expect(queryChips(everything)).toEqual([]);
  });

  test('each narrowing value is a chip, and removing one widens only it', () => {
    const query: BoardAskQuery = {
      ...everything,
      columns: ['finished'],
      checks: 'failed',
      withinDays: 7,
      sources: ['cards', 'prs'],
    };
    expect(queryChips(query).map((c) => c.label)).toEqual([
      'Column: Finished',
      'Checks: failed',
      'Created: last 7 days',
      'In: Cards, PRs',
    ]);
    expect(withoutChip(query, 'column:finished')).toEqual({
      ...query,
      columns: [],
    });
    expect(withoutChip(query, 'sources').sources).toEqual([
      'cards',
      'prs',
      'activity',
    ]);
  });
});

describe('askNotice', () => {
  test('a reached cap names the provider and the reset date', () => {
    const error = new ApiError(429, undefined, 'cap', undefined, {
      error: 'llm_cap_reached',
      provider: 'anthropic',
      resetsAt: '2026-11-01T00:00:00.000Z',
    });
    expect(askNotice(error, 'UTC')).toEqual({
      tone: 'cap',
      title: 'Anthropic has reached its monthly cap',
      text: 'Ask the Board cannot answer until then. It resets on November 1, 2026.',
    });
  });

  test('any other refusal is the server sentence', () => {
    const error = new ApiError(409, undefined, 'x', undefined, {
      error: 'ai_no_model',
      message: 'No default model is set (Admin › AI providers)',
    });
    expect(askNotice(error)).toMatchObject({
      tone: 'error',
      text: 'No default model is set (Admin › AI providers)',
    });
  });
});
