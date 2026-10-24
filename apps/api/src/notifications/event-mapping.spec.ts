import {
  blockedCheckpointDraft,
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

  it('says when the limit resets, and still reads a payload without it (#741)', () => {
    const hit = draftFor(
      event({
        type: 'pane.quota_hit',
        data: {
          target: 'slot',
          limit: 'session',
          resetsAt: '2026-10-21T15:00:00.000Z',
        },
      }),
    );
    expect(hit?.body).toContain('2026-10-21 15:00 UTC');
    expect(
      draftFor(event({ type: 'pane.quota_hit', data: { target: 'slot' } }))
        ?.body,
    ).not.toContain('UTC');
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

  it('never drafts from a checkpoint event: the sweep decides (note 23)', () => {
    const checkpoint = (data: object) =>
      draftFor(event({ type: 'slot.checkpoint', source: 'scraped', data }));
    expect(
      checkpoint({ checkpoint: 'blocked', heading: 'blocked', position: 1 }),
    ).toBeNull();
    expect(checkpoint({ checkpoint: 'pr_open' })).toBeNull();
  });

  it('puts the blocked heading in the body, never the summary', () => {
    expect(
      blockedCheckpointDraft(
        'i42-api',
        42,
        'blocked — the docs question only\nsecond line',
      ),
    ).toEqual({
      kind: 'slot.blocked',
      slot: 'i42-api',
      issue: 42,
      title: 'i42-api (#42) is blocked',
      body: 'blocked — the docs question only',
      page: 'fleet',
    });
  });

  it('falls back to the fixed body when the heading is just "blocked"', () => {
    for (const heading of ['blocked', 'Blocked:', '  BLOCKED  ']) {
      expect(blockedCheckpointDraft('719', 719, heading)).toMatchObject({
        title: 'Issue #719 is blocked',
        body: 'The worker reported a blocked checkpoint.',
      });
    }
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

  describe('board cards (issue #242 D15)', () => {
    const card = (type: string, data: object, source = 'api') =>
      event({ type, source, slot: null, issue: null, data });

    it('maps card.finished, naming the card and its PR, linking the card', () => {
      const draft = draftFor(
        card('card.finished', {
          cardId: 'c1',
          number: 12,
          title: 'Add login',
          round: 1,
          finishedBy: 'worker',
          prNumber: 77,
          prUrl: 'https://github.com/acme/widget/pull/77',
        }),
      );
      expect(draft).toEqual({
        kind: 'card.finished',
        slot: null,
        issue: null,
        title: 'C-12 "Add login" is finished',
        body: 'PR #77 is ready for review.',
        page: 'board',
        card: 12,
      });
      expect(projectLink('p1', 'board', 12)).toBe('/projects/p1/board?card=12');
    });

    it('maps card.finished without a PR', () => {
      expect(
        draftFor(
          card('card.finished', {
            number: 3,
            title: 'Fix it',
            prNumber: null,
          }),
        ),
      ).toMatchObject({
        title: 'C-3 "Fix it" is finished',
        body: 'Review it on the board: accept it, or send feedback.',
      });
    });

    it('maps card.waiting', () => {
      expect(
        draftFor(card('card.waiting', { number: 4, title: 'Add login' })),
      ).toMatchObject({
        kind: 'card.waiting',
        title: 'C-4 "Add login" is waiting for you',
        body: 'Its worker stopped and waits for a reply in its session.',
        page: 'board',
        card: 4,
      });
    });

    it('maps card.waiting on a question the worker asks (#473)', () => {
      expect(
        draftFor(
          card('card.waiting', {
            number: 4,
            title: 'Add login',
            reason: 'question',
          }),
        ),
      ).toMatchObject({
        kind: 'card.waiting',
        title: 'C-4 "Add login" is waiting for you',
        body: 'Its worker asks you a question in its session.',
        card: 4,
      });
    });

    it('maps card.waiting on a dialog that blocks the session (#624)', () => {
      expect(
        draftFor(
          card('card.waiting', {
            number: 4,
            title: 'Add login',
            reason: 'dialog',
            dialog: 'trust',
          }),
        ),
      ).toMatchObject({
        kind: 'card.waiting',
        body: 'Claude Code’s workspace trust dialog blocks the worker’s session. Open its terminal and answer it.',
        card: 4,
      });
      expect(
        draftFor(
          card('card.waiting', {
            number: 4,
            title: 'Add login',
            reason: 'dialog',
            dialog: 'nonsense',
          }),
        )?.body,
      ).toBe(
        'A Claude Code dialog blocks the worker’s session. Open its terminal and answer it.',
      );
    });

    it('maps card.background_stalled without the title or the command (#390)', () => {
      const draft = draftFor(
        card('card.background_stalled', {
          number: 39,
          title: 'secret title',
          round: 1,
          minutes: 30,
        }),
      );
      expect(draft).toMatchObject({
        kind: 'card.background_stalled',
        title: 'C-39 has been waiting on its own background task for 30 min',
        page: 'board',
        card: 39,
      });
      expect(JSON.stringify(draft)).not.toContain('secret');
      expect(
        draftFor(
          card(
            'card.background_stalled',
            { number: 39, minutes: 30 },
            'runner',
          ),
        ),
      ).toBeNull();
    });

    it('never copies more than the title, and only the first line of it', () => {
      const draft = draftFor(
        card('card.waiting', {
          number: 4,
          title: 'Add login\nsecret prompt text',
          summary: 'secret summary',
        }),
      );
      expect(JSON.stringify(draft)).not.toContain('secret');
    });

    it('maps cards.suggested with counts only, never a title (#244 D11)', () => {
      const draft = draftFor(
        card('cards.suggested', {
          captureId: 'cap1',
          sessionId: 's1',
          count: 3,
          cardIds: ['c1', 'c2', 'c3'],
          title: 'secret suggestion',
        }),
      );
      expect(draft).toEqual({
        kind: 'cards.suggested',
        slot: null,
        issue: null,
        title: '3 cards were suggested',
        body: 'Capture found follow-up work in a session; review it in the Inbox.',
        page: 'board',
      });
      expect(JSON.stringify(draft)).not.toContain('secret');
      expect(draftFor(card('cards.suggested', { count: 1 }))?.title).toBe(
        'A card was suggested',
      );
      expect(draftFor(card('cards.suggested', { count: 1 }, 'runner'))).toBe(
        null,
      );
      expect(draftFor(card('cards.suggested', { count: 0 }))).toBeNull();
    });

    it('maps card.demo, ready or failed with its reason (C-372)', () => {
      expect(
        draftFor(
          card('card.demo', {
            number: 12,
            title: 'Add login',
            demoId: 'd1',
            status: 'ready',
          }),
        ),
      ).toEqual({
        kind: 'card.demo',
        slot: null,
        issue: null,
        title: 'The demo of C-12 "Add login" is ready',
        body: 'Watch it, then merge it or send feedback.',
        page: 'board',
        card: 12,
      });
      expect(
        draftFor(
          card('card.demo', {
            number: 12,
            title: 'Add login',
            status: 'failed',
            reason: 'Step 3 timed out',
          }),
        ),
      ).toMatchObject({
        title: 'The demo of C-12 "Add login" failed',
        body: 'Step 3 timed out',
      });
      expect(
        draftFor(card('card.demo', { number: 12, status: 'recording' })),
      ).toBeNull();
    });

    it('does not let a runner forge a card event, and needs a number', () => {
      for (const type of ['card.finished', 'card.waiting', 'card.demo']) {
        expect(draftFor(card(type, { number: 1 }, 'runner'))).toBeNull();
        expect(draftFor(card(type, { title: 'x' }))).toBeNull();
      }
    });
  });

  describe('Steward incidents (#447 D13)', () => {
    const incident = (
      type: string,
      data: object = {},
      source = 'api',
    ): MatchableEvent =>
      event({
        type,
        source,
        slot: null,
        issue: null,
        data: {
          incidentId: 'inc1',
          subjectKind: 'card_round',
          subjectId: 'round1',
          subjectLabel: 'C-12',
          cardNumber: 12,
          kind: 'api_error',
          reason: 'API Error: Connection lost mid-response',
          ...data,
        },
      });

    it('maps an escalation to one steward.incident naming the card and the reason', () => {
      expect(draftFor(incident('steward_incident.escalated'))).toEqual({
        kind: 'steward.incident',
        slot: null,
        issue: null,
        title: 'C-12 needs you: API error',
        body: 'API Error: Connection lost mid-response',
        page: 'board',
        card: 12,
      });
    });

    it('sends a fleet slot to the Fleet page', () => {
      expect(
        draftFor(
          incident('steward_incident.escalated', {
            subjectKind: 'fleet_slot',
            subjectId: 'i447-api',
            subjectLabel: 'i447-api',
            cardNumber: undefined,
            kind: 'silent',
            reason: 'no hook event for 10+ min',
          }),
        ),
      ).toMatchObject({
        slot: 'i447-api',
        title: 'i447-api needs you: silent',
        page: 'fleet',
      });
    });

    it('notifies nobody of an opening, an action or a recovery', () => {
      for (const type of [
        'steward_incident.opened',
        'steward_incident.acted',
        'steward_incident.resolved',
      ]) {
        expect(draftFor(incident(type))).toBeNull();
      }
    });

    it('never takes one a runner forged, or one that does not parse', () => {
      expect(
        draftFor(incident('steward_incident.escalated', {}, 'runner')),
      ).toBeNull();
      expect(
        draftFor(incident('steward_incident.escalated', { reason: 'a\nb' })),
      ).toBeNull();
    });
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
