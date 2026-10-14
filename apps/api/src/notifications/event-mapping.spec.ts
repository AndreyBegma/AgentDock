import {
  draftFor,
  type MatchableEvent,
  oneLine,
  projectLink,
} from './event-mapping';

const event = (overrides: Partial<MatchableEvent>): MatchableEvent => ({
  id: 1n,
  runnerId: 'r1',
  seq: 1n,
  ts: new Date('2026-10-08T10:00:00Z'),
  type: 'pane.prompt',
  source: 'runner',
  projectRepo: 'acme/widget',
  projectRoot: '/srv/dev/widget',
  slot: 'i42-api',
  issue: 42,
  data: { target: 'slot', dialog: 'trust' },
  ...overrides,
});

describe('draftFor (spec 22 D1)', () => {
  it('maps pane.prompt to a slot prompt naming the dialog', () => {
    expect(draftFor(event({}))).toMatchObject({
      kind: 'pane.prompt',
      slot: 'i42-api',
      issue: 42,
      title: 'i42-api (#42) is waiting on a launch dialog',
      body: 'A trust dialog needs a key press.',
    });
  });

  it('maps an orchestrator pane prompt without a slot', () => {
    const draft = draftFor(
      event({ slot: null, issue: null, data: { target: 'orchestrator' } }),
    );
    expect(draft).toMatchObject({ kind: 'pane.prompt', slot: null });
    expect(draft?.title).toMatch(/^The orchestrator/);
  });

  it('maps pane.quota_hit to quota.hit', () => {
    expect(
      draftFor(event({ type: 'pane.quota_hit', data: { target: 'slot' } }))
        ?.kind,
    ).toBe('quota.hit');
  });

  it('ignores the plugin echo of a pane event', () => {
    expect(draftFor(event({ source: 'code-sentinel' }))).toBeNull();
  });

  it('ignores a pane event whose data does not parse', () => {
    expect(draftFor(event({ data: { dialog: 'nonsense' } }))).toBeNull();
  });

  it('maps person.needed with the first line of the question', () => {
    const draft = draftFor(
      event({
        type: 'person.needed',
        source: 'code-sentinel',
        data: { question: '\nMerge order of #41 and #42?\nmore', slot: 'x' },
      }),
    );
    expect(draft).toMatchObject({
      kind: 'person.needed',
      body: 'Merge order of #41 and #42?',
    });
  });

  it('maps only a blocked checkpoint to slot.blocked, without its summary', () => {
    const blocked = draftFor(
      event({
        type: 'slot.checkpoint',
        data: { checkpoint: 'blocked', summary: 'secret stack trace' },
      }),
    );
    expect(blocked?.kind).toBe('slot.blocked');
    expect(JSON.stringify(blocked)).not.toContain('secret stack trace');
    expect(
      draftFor(
        event({ type: 'slot.checkpoint', data: { checkpoint: 'pr_open' } }),
      ),
    ).toBeNull();
  });

  it('names the issue when a blocked title has no slot name', () => {
    const blocked = (slot: string | null, issue: number | null) =>
      draftFor(
        event({
          type: 'issue.blocked',
          slot,
          issue,
          data: { kind: 'person' },
        }),
      )?.title;
    expect(blocked(null, 719)).toBe('Issue #719 is blocked on a person');
    // A slot named by the bare number is the issue, not a name.
    expect(blocked('719', null)).toBe('Issue #719 is blocked on a person');
    expect(blocked('719', 719)).toBe('Issue #719 is blocked on a person');
    expect(blocked('i719-api', 719)).toBe(
      'i719-api (#719) is blocked on a person',
    );
  });

  it('maps issue.blocked only when a person is needed', () => {
    expect(
      draftFor(
        event({
          type: 'issue.blocked',
          slot: null,
          data: { issue: 7, kind: 'person', why: 'needs a decision' },
        }),
      ),
    ).toMatchObject({
      kind: 'slot.blocked',
      issue: 42,
      body: 'needs a decision',
    });
    expect(
      draftFor(event({ type: 'issue.blocked', data: { kind: 'work' } })),
    ).toBeNull();
  });

  it('maps pr.awaiting_approval with the PR number', () => {
    expect(
      draftFor(event({ type: 'pr.awaiting_approval', data: { pr: '17' } }))
        ?.title,
    ).toBe('PR #17 is waiting for approval');
  });

  it('flags a round with nothing ready and nothing in flight as queue.dry', () => {
    const decided = (dispatching: object[], inFlight: object[]) =>
      event({
        type: 'round.decided',
        slot: null,
        data: {
          decisions: {
            dispatching,
            heldForLead: [],
            notDispatching: [{ Issue: '#3' }],
            inFlight,
          },
        },
      });
    expect(draftFor(decided([], []))?.kind).toBe('queue.dry');
    expect(draftFor(decided([{ Issue: '#1' }], []))).toBeNull();
    expect(draftFor(decided([], [{ Issue: '#2' }]))).toBeNull();
  });

  it('maps an API-recorded schedule.disabled, linking the schedules page', () => {
    const disabled = event({
      type: 'schedule.disabled',
      source: 'api',
      slot: null,
      issue: null,
      data: {
        scheduleId: 's1',
        scheduleName: 'Nightly triage',
        firingId: '9',
        disabledReason: 'failing',
      },
    });
    expect(draftFor(disabled)).toMatchObject({
      kind: 'schedule.disabled',
      slot: null,
      issue: null,
      title: 'Schedule "Nightly triage" was disabled',
      page: 'schedules',
    });
    expect(projectLink('p1', 'schedules')).toBe('/projects/p1/schedules');
  });

  it('does not let a runner forge schedule.disabled', () => {
    expect(
      draftFor(event({ type: 'schedule.disabled', source: 'runner' })),
    ).toBeNull();
    expect(
      draftFor(event({ type: 'schedule.disabled', source: 'code-sentinel' })),
    ).toBeNull();
  });

  it.each([
    'events.duplicate',
    'events.unparsed',
    'pr.merged',
    'pane.idle',
  ])('never notifies on %s', (type) => {
    expect(draftFor(event({ type }))).toBeNull();
  });
});

describe('oneLine', () => {
  it('keeps the first non-empty line and cuts it', () => {
    expect(oneLine('  \n  hello  \nworld')).toBe('hello');
    expect(oneLine('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(oneLine(42)).toBeNull();
    expect(oneLine('\n \n')).toBeNull();
  });
});
