import { describe, expect, it } from 'bun:test';
import {
  eventSchema,
  issueCreateArgsSchema,
  parseQueueEvent,
  QUEUE_EVENT_TYPES,
  type RunnerEvent,
} from '../protocol';
import {
  boardIssueRef,
  boardVerdicts,
  heldForLead,
  normalizeBoardState,
} from './board';
import {
  branchIssue,
  comparePriority,
  hasAcceptanceCriteria,
  hasParallelPlan,
  hasReproduction,
  parseClosingRefs,
  parseDependsOn,
  parseGate,
  parseParallelPlan,
  priorityOf,
  specGap,
} from './rules';

const AC = '## Acceptance criteria\n- [ ] it works\n';

describe('parseDependsOn', () => {
  it('reads every issue on every Depends on line', () => {
    expect(
      parseDependsOn('Intro\n\nDepends on #10\nDepends on #11, #9\n'),
    ).toEqual([9, 10, 11]);
  });

  it('reads list items and bold markers', () => {
    expect(parseDependsOn('- **Depends on** #4\n* depends on #5')).toEqual([
      4, 5,
    ]);
  });

  it('ignores a mention inside a sentence, code fences and other repositories', () => {
    expect(
      parseDependsOn(
        [
          '- [ ] a body with `Depends on #m` where m is open',
          '```',
          'Depends on #3',
          '```',
          'Depends on acme/other#7',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('parseGate', () => {
  it('quotes the Gate line', () => {
    expect(parseGate('Body\nGate: security review by the owner\n')).toBe(
      'Gate: security review by the owner',
    );
    expect(parseGate('- **Gate:** legal sign-off')).toBe(
      '- **Gate:** legal sign-off',
    );
  });

  it('is null without a gate, or when the gate says none', () => {
    expect(parseGate('## Gates\nnone')).toBeNull();
    expect(parseGate('Gate: none')).toBeNull();
    expect(parseGate('Gate: —')).toBeNull();
    expect(parseGate('Investigate the gateway: it fails')).toBeNull();
  });
});

describe('hasAcceptanceCriteria', () => {
  it('accepts a section with a checkbox item', () => {
    expect(hasAcceptanceCriteria(AC)).toBe(true);
    expect(hasAcceptanceCriteria('### Acceptance criteria\n\n* [x] done')).toBe(
      true,
    );
  });

  it('accepts a bold line followed by a checkbox list', () => {
    expect(
      hasAcceptanceCriteria('**Acceptance criteria**\n\n- [ ] one\n- [ ] two'),
    ).toBe(true);
  });

  it('rejects a section without checkboxes, or checkboxes in another section', () => {
    expect(hasAcceptanceCriteria('## Acceptance criteria\nit works')).toBe(
      false,
    );
    expect(
      hasAcceptanceCriteria(
        '## Acceptance criteria\nsee below\n## Tasks\n- [ ] a task',
      ),
    ).toBe(false);
    expect(hasAcceptanceCriteria('- [ ] a todo')).toBe(false);
  });

  it('keeps sub-headings inside the section', () => {
    expect(
      hasAcceptanceCriteria('## Acceptance criteria\n### API\n- [ ] one'),
    ).toBe(true);
  });
});

describe('specGap', () => {
  it('is null with acceptance criteria', () => {
    expect(specGap(AC, [])).toBeNull();
  });

  it('accepts a reproduction for a bug only', () => {
    const body = '## Steps to reproduce\n1. open it';
    expect(specGap(body, ['bug'])).toBeNull();
    expect(specGap(body, ['enhancement'])).toBe('no_acceptance_criteria');
    expect(hasReproduction('## Reproduction\n')).toBe(false);
  });

  it('needs a parallel plan for size XL and XXL', () => {
    expect(specGap(AC, ['size: XL'])).toBe('no_parallel_plan');
    expect(specGap(AC, ['size: XXL'])).toBe('no_parallel_plan');
    expect(specGap(AC, ['size: L'])).toBeNull();
    expect(specGap(`${AC}\n## Parallel plan\n`, ['size: XL'])).toBeNull();
  });
});

describe('parseParallelPlan', () => {
  const body = [
    '## Parallel plan',
    '| Slot | Owns | Touches | Depends on | Lead | Model |',
    '|---|---|---|---|---|---|',
    '| i19-api | schema | a | — | yes | opus |',
    '| i19-web | page | b | i19-api | no | sonnet |',
    '',
    'Text after the table.',
  ].join('\n');

  it('lists slot, lead and model', () => {
    expect(hasParallelPlan(body)).toBe(true);
    expect(parseParallelPlan(body)).toEqual([
      { slot: 'i19-api', lead: true, model: 'opus' },
      { slot: 'i19-web', lead: false, model: 'sonnet' },
    ]);
  });

  it('is null without a plan', () => {
    expect(parseParallelPlan(AC)).toBeNull();
  });
});

describe('parseClosingRefs', () => {
  it('reads closing keywords', () => {
    expect(
      parseClosingRefs('Closes #19\nfixes #3, resolved: #4\nPart of #7'),
    ).toEqual([3, 4, 19]);
  });

  it('ignores other repositories', () => {
    expect(parseClosingRefs('Closes acme/other#19')).toEqual([]);
  });
});

describe('branchIssue', () => {
  it('reads */<n>-*', () => {
    expect(branchIssue('feat/19-queue-api')).toBe(19);
    expect(branchIssue('main')).toBeNull();
  });
});

describe('priority', () => {
  it('takes the highest priority label', () => {
    expect(priorityOf(['priority: medium', 'priority: high'])).toBe('high');
    expect(priorityOf(['bug'])).toBeNull();
  });

  it('orders critical > high > medium > none, then by number', () => {
    const items = [
      { priority: null, number: 1 },
      { priority: 'medium' as const, number: 9 },
      { priority: 'critical' as const, number: 30 },
      { priority: 'medium' as const, number: 4 },
    ];
    expect(items.sort(comparePriority).map((i) => i.number)).toEqual([
      30, 4, 9, 1,
    ]);
  });
});

describe('board', () => {
  it('normalizes the states as the orchestrator writes them', () => {
    expect(normalizeBoardState('BLOCKED — work')).toBe('blocked_work');
    expect(normalizeBoardState('`BLOCKED - person`')).toBe('blocked_person');
    expect(normalizeBoardState('**NO SPEC**')).toBe('no_spec');
    expect(normalizeBoardState('later')).toBeNull();
    expect(boardIssueRef('[#19](https://x) — title')).toBe(19);
  });

  it('reads verdicts from every table, the first row winning', () => {
    const verdicts = boardVerdicts({
      dispatching: [{ Slot: 'i20-api', Issue: '#20' }],
      heldForLead: [
        { Slot: 'i19-web', 'Waiting on': 'i19-api', 'Dispatch when': 'merged' },
      ],
      notDispatching: [
        {
          Issue: '#21',
          State: 'BLOCKED — work',
          Why: 'depends on #19',
          'What would clear it': '#19 merges',
        },
        { Issue: '#20', State: 'READY', Why: '', 'What would clear it': '' },
        { Issue: '#22', State: 'whatever', Why: '' },
      ],
      inFlight: [
        { 'Slot / PR': '#51', Issue: '#18', 'Where it got to': 'review' },
      ],
    });
    expect(Object.fromEntries(verdicts)).toEqual({
      18: { state: 'in_flight', why: 'review', clears: null },
      20: { state: 'in_flight', why: 'dispatched as i20-api', clears: null },
      21: {
        state: 'blocked_work',
        why: 'depends on #19',
        clears: '#19 merges',
      },
    });
  });

  it('lists held-for-lead rows', () => {
    expect(
      heldForLead({
        dispatching: [],
        notDispatching: [],
        inFlight: [],
        heldForLead: [
          {
            Slot: 'i19-web',
            'Waiting on': 'i19-api',
            'Dispatch when': 'merged',
          },
          { Slot: '', 'Waiting on': 'x' },
        ],
      }),
    ).toEqual([
      { slot: 'i19-web', waitingOn: 'i19-api', dispatchWhen: 'merged' },
    ]);
  });
});

const event = (
  type: string,
  data: unknown,
  extra: Partial<RunnerEvent> = {},
): RunnerEvent =>
  eventSchema.parse({
    v: 1,
    seq: 1,
    ts: '2026-10-08T10:00:00.000Z',
    type,
    source: 'runner',
    project: { repo: 'acme/widget', root: '/srv/widget' },
    ...extra,
    data,
  });

describe('queue events', () => {
  const snapshot = {
    snapshotId: 's1',
    fetchedAt: '2026-10-08T10:00:00Z',
    part: 0,
    parts: 1,
    open: [1, 2],
    issues: [
      {
        number: 1,
        title: 'One',
        labels: ['cs:ready'],
        assignees: [],
        body: AC,
        updatedAt: '2026-10-08T09:00:00Z',
        url: 'https://github.com/acme/widget/issues/1',
      },
    ],
    pullRequests: [
      {
        number: 2,
        title: 'Two',
        body: 'Closes #1',
        updatedAt: '2026-10-08T09:00:00Z',
        url: 'https://github.com/acme/widget/pull/2',
      },
    ],
  };

  it('parses every type', () => {
    expect(QUEUE_EVENT_TYPES).toEqual([
      'issues.snapshot',
      'issue.closed',
      'issues.unavailable',
    ]);
    expect(parseQueueEvent(event('issues.snapshot', snapshot))?.ok).toBe(true);
    expect(
      parseQueueEvent(
        event('issue.closed', { number: 3, closedBy: 'pr', pr: 9 }),
      )?.ok,
    ).toBe(true);
    expect(
      parseQueueEvent(event('issues.unavailable', { reason: 'gh: 401' }))?.ok,
    ).toBe(true);
    expect(parseQueueEvent(event('pr.opened', {}))).toBeNull();
  });

  it('refuses a part beyond parts, a manual closure with a pr, and no project', () => {
    expect(
      parseQueueEvent(event('issues.snapshot', { ...snapshot, part: 1 }))?.ok,
    ).toBe(false);
    expect(
      parseQueueEvent(
        event('issue.closed', { number: 3, closedBy: 'manual', pr: 9 }),
      )?.ok,
    ).toBe(false);
    expect(
      parseQueueEvent(
        event('issues.unavailable', { reason: 'x' }, { project: undefined }),
      )?.ok,
    ).toBe(false);
  });
});

describe('issue.create args', () => {
  it('needs a title and caps the labels', () => {
    const args = {
      projectId: 'p1',
      title: 'Add a queue',
      body: AC,
      labels: ['enhancement'],
      queue: true,
    };
    expect(issueCreateArgsSchema.safeParse(args).success).toBe(true);
    expect(
      issueCreateArgsSchema.safeParse({ ...args, title: '  ' }).success,
    ).toBe(false);
    expect(
      issueCreateArgsSchema.safeParse({
        ...args,
        labels: Array.from({ length: 21 }, (_, i) => `l${i}`),
      }).success,
    ).toBe(false);
  });
});
