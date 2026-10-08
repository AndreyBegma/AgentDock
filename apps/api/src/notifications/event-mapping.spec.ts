import { draftFor, type MatchableEvent, oneLine } from './event-mapping';

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
