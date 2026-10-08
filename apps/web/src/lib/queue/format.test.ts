import { describe, expect, test } from 'bun:test';
import type { QueueItemView, QueueState, QueueView } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  allowedLabels,
  boardColumns,
  computedNote,
  countByState,
  describeQueueError,
  filterItems,
  gapSentence,
  parseStateFilter,
  queueHint,
  refusedLabels,
  safeHttpsUrl,
  stateLabel,
} from './format';

const item = (
  number: number,
  state: QueueState,
  extra: Partial<QueueItemView> = {},
): QueueItemView => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  labels: [],
  assignees: [],
  state,
  why: '',
  clears: null,
  source: 'computed',
  computed: null,
  priority: null,
  blockers: [],
  waveSlots: null,
  ghUpdatedAt: '2026-10-08T00:00:00Z',
  ...extra,
});

const view = (
  items: QueueItemView[],
  others: QueueView['others'],
): QueueView => ({
  snapshotAt: null,
  unavailable: null,
  readyLabel: 'cs:ready',
  round: null,
  items,
  heldForLead: [],
  others,
});

const apiError = (
  status: number,
  code: string,
  body: Record<string, unknown> = {},
) => new ApiError(status, code as never, 'raw', undefined, body);

describe('state filter', () => {
  const items = [item(1, 'ready'), item(2, 'blocked_work'), item(3, 'ready')];

  test('parseStateFilter accepts a state and falls back to all', () => {
    expect(parseStateFilter('no_spec')).toBe('no_spec');
    expect(parseStateFilter('nonsense')).toBe('all');
    expect(parseStateFilter('')).toBe('all');
  });

  test('filterItems keeps the API order inside a state', () => {
    expect(filterItems(items, 'ready').map((i) => i.number)).toEqual([1, 3]);
    expect(filterItems(items, 'all')).toHaveLength(3);
    expect(filterItems(items, 'no_spec')).toEqual([]);
  });

  test('countByState counts every state, zeros included', () => {
    expect(countByState(items)).toEqual({
      ready: 2,
      in_flight: 0,
      blocked_work: 1,
      blocked_person: 0,
      no_spec: 0,
    });
  });
});

describe('boardColumns', () => {
  test('always five fixed columns titled as the orchestrator writes them', () => {
    const columns = boardColumns([item(7, 'blocked_person')]);
    expect(columns.map((c) => c.title)).toEqual([
      'READY',
      'IN FLIGHT',
      'BLOCKED — work',
      'BLOCKED — person',
      'NO SPEC',
    ]);
    expect(columns.map((c) => c.cards.length)).toEqual([0, 0, 0, 1, 0]);
  });

  test('a card id is the issue number, its label names the issue', () => {
    const [ready] = boardColumns([item(7, 'ready')]);
    expect(ready.cards[0].id).toBe('7');
    expect(ready.cards[0].label).toBe('#7 Issue 7');
  });
});

describe('computedNote', () => {
  const computed = { state: 'ready' as const, why: '', clears: null };

  test('shown when the orchestrator disagrees with AgentDock', () => {
    const disagree = item(1, 'blocked_work', {
      source: 'orchestrator',
      computed,
    });
    expect(computedNote(disagree)).toBe('AgentDock computes READY');
  });

  test('absent when they agree, or when the verdict is computed', () => {
    expect(
      computedNote(item(1, 'ready', { source: 'orchestrator', computed })),
    ).toBeNull();
    expect(computedNote(item(1, 'ready'))).toBeNull();
  });
});

describe('allowedLabels', () => {
  test('before the first load only the always-allowed labels', () => {
    expect(allowedLabels(undefined)).toEqual(['enhancement', 'bug']);
  });

  test('labels seen on the queue and on open issues, deduplicated, without the ready label', () => {
    const labels = allowedLabels(
      view(
        [item(1, 'ready', { labels: ['cs:ready', 'Bug', 'priority: high'] })],
        [
          {
            number: 2,
            title: 't',
            url: 'u',
            labels: ['CS:READY', 'docs', 'priority: high'],
          },
        ],
      ),
    );
    expect(labels).toEqual(['bug', 'docs', 'enhancement', 'priority: high']);
  });
});

describe('queueHint', () => {
  test('a body with acceptance criteria can be queued', () => {
    const hint = queueHint('## Acceptance criteria\n- [ ] it works', []);
    expect(hint).toEqual({ canQueue: true, gap: null });
  });

  test('no acceptance criteria cannot be queued, and says why', () => {
    const hint = queueHint('just do it', []);
    expect(hint.canQueue).toBe(false);
    expect(hint.gap).toBe('no_acceptance_criteria');
    const sentence = gapSentence('no_acceptance_criteria');
    expect(sentence).toContain('Cannot be queued');
    expect(sentence).not.toContain('`');
  });

  test('size: XL without a parallel plan is a different gap', () => {
    const body = '## Acceptance criteria\n- [ ] done';
    expect(queueHint(body, ['size: XL']).gap).toBe('no_parallel_plan');
    expect(
      queueHint(`${body}\n## Parallel plan\n| Slot |\n|---|\n| a |`, [
        'size: XL',
      ]).canQueue,
    ).toBe(true);
  });
});

describe('describeQueueError', () => {
  test('each 422 reason is its own sentence', () => {
    expect(
      describeQueueError(apiError(422, 'no_acceptance_criteria')),
    ).toContain('acceptance criteria');
    expect(describeQueueError(apiError(422, 'no_parallel_plan'))).toContain(
      'Parallel plan',
    );
  });

  test('label_not_allowed lists the refused labels', () => {
    const error = apiError(422, 'label_not_allowed', { labels: ['x', 'y'] });
    expect(refusedLabels(error)).toEqual(['x', 'y']);
    expect(describeQueueError(error)).toContain('x, y');
  });

  test('label_not_allowed without a labels field still reads as a sentence', () => {
    expect(describeQueueError(apiError(422, 'label_not_allowed'))).toContain(
      'not allowed',
    );
  });

  test('command_unavailable says the runner part is not deployed', () => {
    expect(describeQueueError(apiError(503, 'command_unavailable'))).toContain(
      'runner part is not deployed yet',
    );
  });

  test('a 404 reads as a missing project, anything else falls through', () => {
    expect(
      describeQueueError(new ApiError(404, undefined, 'Not Found')),
    ).toContain('no longer exists');
    expect(describeQueueError(new Error('boom'))).toBe(
      'Could not reach the server.',
    );
  });
});

describe('misc', () => {
  test('safeHttpsUrl only lets https through', () => {
    expect(safeHttpsUrl('https://github.com/o/r/issues/1')).not.toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });

  test('stateLabel is the board wording', () => {
    expect(stateLabel('blocked_work')).toBe('BLOCKED — work');
  });
});
