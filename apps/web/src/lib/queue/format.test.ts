import { describe, expect, test } from 'bun:test';
import {
  QUEUE_STATES,
  type QueueItemView,
  type QueueState,
  type QueueView,
} from '@agentdock/shared';
import { ApiError } from '../api';
import {
  allowedLabels,
  boardColumns,
  computedNote,
  countByState,
  describeQueueError,
  filterItems,
  gapSentence,
  heldForLeadSummary,
  parseStateFilter,
  QUEUE_FILTER_CODEC,
  queueEmptyDescription,
  queueHint,
  queueUnavailableCopy,
  refusedLabels,
  roundFooter,
  STATE_CHIP_LABEL,
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

describe('chip labels and the held-for-lead count', () => {
  test('every state has a sentence-case chip label', () => {
    for (const label of Object.values(STATE_CHIP_LABEL)) {
      expect(label).not.toBe(label.toUpperCase());
      expect(label).not.toContain('—');
    }
    expect(Object.keys(STATE_CHIP_LABEL).sort()).toEqual(
      [...QUEUE_STATES].sort(),
    );
  });

  test('the held summary counts slots and says they are not issues', () => {
    expect(heldForLeadSummary(1)).toStartWith('1 slot held.');
    expect(heldForLeadSummary(3)).toStartWith('3 slots held.');
    expect(heldForLeadSummary(3)).toContain('apart from the issues');
  });
});

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

  test('shown when the orchestrator disagrees with Nautelle', () => {
    const disagree = item(1, 'blocked_work', {
      source: 'orchestrator',
      computed,
    });
    expect(computedNote(disagree)).toBe('Nautelle computes READY');
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

  test('command_unavailable without a runner name still says to update it', () => {
    expect(describeQueueError(apiError(503, 'command_unavailable'))).toContain(
      'Update the Nautelle runner on the project’s machine',
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

  test('an old runner is named and told to update, with no developer wording', () => {
    const text = describeQueueError(
      new ApiError(503, 'command_unavailable' as never, 'x'),
      'laptop',
    );
    expect(text).toContain('Update the Nautelle runner on laptop');
    expect(text).not.toContain('not deployed');
  });

  test('the empty queue says how an issue gets in, and notes a missing snapshot', () => {
    const seen = queueEmptyDescription('ready', '2026-10-13T10:00:00Z');
    expect(seen).toContain('“ready” label');
    expect(seen).toContain('Acceptance criteria');
    expect(seen).not.toContain('first snapshot');
    expect(queueEmptyDescription('ready', null)).toContain('first snapshot');
  });

  test('an unreadable queue names the cause and the runner', () => {
    const admin = queueUnavailableCopy({ reason: 'bad token' }, 'laptop', true);
    expect(admin.body).toContain('bad token');
    expect(admin.body).toContain('laptop');
    expect(admin.href).toBe('/admin/runners');
    expect(
      queueUnavailableCopy({ reason: 'x' }, null, false).href,
    ).toBeUndefined();
  });

  test('a gh failure names gh on the runner, not the Runners page (#213)', () => {
    const copy = queueUnavailableCopy(
      { reason: 'gh is not available or timed out' },
      'i185-screens',
      true,
    );
    expect(copy.cta).toBe('Set up gh on i185-screens');
    expect(copy.href).toBe('/install#troubleshooting');
    expect(copy.body).toContain('gh auth login');
    // A member who is not an admin gets the fix too: it is on the machine.
    expect(
      queueUnavailableCopy({ reason: 'gh timed out' }, null, false).cta,
    ).toBe('Set up gh on the runner');
    // A word that merely contains "gh" is not the GitHub CLI.
    expect(queueUnavailableCopy({ reason: 'high load' }, null, true).cta).toBe(
      'Open Runners',
    );
  });

  test('the state chip and the view round-trip through the URL', () => {
    const parse = (s: string) =>
      QUEUE_FILTER_CODEC.parse(new URLSearchParams(s));
    expect(parse('')).toEqual({ state: 'all', view: 'list' });
    expect(parse('state=ready&view=board')).toEqual({
      state: 'ready',
      view: 'board',
    });
    expect(parse('state=bogus').state).toBe('all');
    expect(QUEUE_FILTER_CODEC.search({ state: 'all', view: 'list' })).toBe('');
    expect(
      QUEUE_FILTER_CODEC.search({ state: 'blocked_person', view: 'list' }),
    ).toBe('?state=blocked_person');
  });

  test('the round footer explains the dot', () => {
    expect(roundFooter({ date: '2026-10-13', round: '1030' })).toContain(
      'green dot',
    );
  });

  test('stateLabel is the board wording', () => {
    expect(stateLabel('blocked_work')).toBe('BLOCKED — work');
  });
});
