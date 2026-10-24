import { CARD_HOOKS_GRACE_MS, type StewardCardChip } from '@nautelle/shared';
import type { ProfileAgentdock } from '@nautelle/shared/protocol';
import type { BoardCard, BoardCardRound } from '@prisma/client';
import {
  type CardFacts,
  type CardReviewRunFact,
  type CardWithRounds,
  escalationOf,
  hooksCauseOf,
  quotaWaitOf,
  recommendationOf,
  restartOf,
  reviewOf,
  roundPushesOf,
  stewardChipOf,
  takenOf,
} from './board-mapper';

const now = new Date('2026-10-16T12:00:00.000Z');

const card = (over: Partial<BoardCard> = {}): BoardCard =>
  ({ projectId: 'p1', sessionId: 's1', ...over }) as BoardCard;

const round = (over: Partial<BoardCardRound> = {}): BoardCardRound =>
  ({
    runId: 'run1',
    phase: 'running',
    startedAt: new Date(now.getTime() - CARD_HOOKS_GRACE_MS - 1000),
    ...over,
  }) as BoardCardRound;

const facts = (
  over: {
    runs?: [string, string][];
    reports?: Record<string, ProfileAgentdock>;
    hooked?: string[];
  } = {},
): CardFacts => ({
  costs: new Map(),
  hooked: new Set(over.hooked ?? []),
  alive: new Set(),
  runProfileKeys: new Map(over.runs ?? [['run1', 'claude-main']]),
  profileAgentdock: new Map([['p1', over.reports ?? {}]]),
  attachmentCounts: new Map(),
  dependencies: new Map(),
  tokenSaver: {
    tokenSaved: new Map(),
    tokenSaverFilters: new Map(),
    artifactIncomplete: new Set(),
    tokenSavedBySession: new Map(),
    tokenSaverFiltersBySession: new Map(),
  },
  now,
});

describe('hooksCauseOf (#348 D1)', () => {
  it('is no_plugin when the round profile reports no plugin', () => {
    const reports = { 'claude-main': { plugin: null, telemetry: false } };
    expect(hooksCauseOf(card(), round(), facts({ reports }))).toEqual({
      hooksCause: 'no_plugin',
      hooksProfile: 'claude-main',
    });
  });

  it('is session_predates when the round profile reports a version', () => {
    const reports = { 'claude-main': { plugin: '0.4.2', telemetry: true } };
    expect(hooksCauseOf(card(), round(), facts({ reports }))).toEqual({
      hooksCause: 'session_predates',
      hooksProfile: 'claude-main',
    });
  });

  it('is unknown when the run has no profile key', () => {
    const reports = { 'claude-main': { plugin: null, telemetry: false } };
    expect(hooksCauseOf(card(), round(), facts({ runs: [], reports }))).toEqual(
      { hooksCause: 'unknown', hooksProfile: null },
    );
  });

  it('is unknown when the runner reports no agentdock for the profile', () => {
    expect(hooksCauseOf(card(), round(), facts())).toEqual({
      hooksCause: 'unknown',
      hooksProfile: 'claude-main',
    });
  });

  it('is null while hooks are not missing', () => {
    const reports = { 'claude-main': { plugin: null, telemetry: false } };
    const none = { hooksCause: null, hooksProfile: null };
    expect(
      hooksCauseOf(card(), round(), facts({ reports, hooked: ['s1'] })),
    ).toEqual(none);
    expect(
      hooksCauseOf(
        card(),
        round({ startedAt: new Date(now.getTime() - 1000) }),
        facts({ reports }),
      ),
    ).toEqual(none);
    expect(
      hooksCauseOf(card(), round({ phase: 'finished' }), facts({ reports })),
    ).toEqual(none);
  });

  it('reads the reports of the card project only', () => {
    const other: CardFacts = {
      ...facts(),
      profileAgentdock: new Map([
        ['p2', { 'claude-main': { plugin: null, telemetry: false } }],
      ]),
    };
    expect(hooksCauseOf(card(), round(), other).hooksCause).toBe('unknown');
  });
});

describe('stewardChipOf (#447 D15)', () => {
  const chip: StewardCardChip = {
    incidentId: 'inc1',
    kind: 'api_error',
    status: 'open',
    actions: [{ action: 'nudge', at: now.toISOString(), result: 'ok' }],
  };
  const withRounds = (...ids: string[]): CardWithRounds =>
    ({
      ...card(),
      rounds: ids.map((id) => round({ id })),
    }) as CardWithRounds;

  it("is the latest round's live incident", () => {
    const steward = new Map([['r2', chip]]);
    expect(stewardChipOf(withRounds('r2', 'r1'), { steward })).toEqual(chip);
  });

  it("never shows an earlier round's incident", () => {
    const steward = new Map([['r1', chip]]);
    expect(stewardChipOf(withRounds('r2', 'r1'), { steward })).toBeNull();
  });

  it('is null without rounds or without the facts', () => {
    expect(stewardChipOf(withRounds(), { steward: new Map() })).toBeNull();
    expect(stewardChipOf(withRounds('r1'), {})).toBeNull();
  });
});

describe('restartOf (#449 D9)', () => {
  const withRounds = (...rounds: Partial<BoardCardRound>[]): CardWithRounds =>
    ({ ...card(), rounds: rounds.map((r) => round(r)) }) as CardWithRounds;
  const restartSavings = new Map([
    ['r2', '0.412500'],
    ['r1', '0.100000'],
  ]);

  it("is the latest fresh round's mode and saving", () => {
    expect(
      restartOf(
        withRounds(
          { id: 'r2', restartMode: 'fresh' },
          { id: 'r1', restartMode: 'fresh' },
        ),
        { restartSavings },
      ),
    ).toEqual({ restartMode: 'fresh', warmupSavedUsd: '0.412500' });
  });

  it('shows no saving after a resume, nor an earlier round’s', () => {
    expect(
      restartOf(
        withRounds(
          { id: 'r2', restartMode: 'resume' },
          { id: 'r1', restartMode: 'fresh' },
        ),
        { restartSavings },
      ),
    ).toEqual({ restartMode: 'resume', warmupSavedUsd: null });
  });

  it('is null without rounds, before round.restart, or without the facts', () => {
    const none = { restartMode: null, warmupSavedUsd: null };
    expect(restartOf(withRounds(), { restartSavings })).toEqual(none);
    expect(
      restartOf(withRounds({ id: 'r2', restartMode: null }), {
        restartSavings,
      }),
    ).toEqual(none);
    expect(
      restartOf(withRounds({ id: 'r2', restartMode: 'fresh' }), {}),
    ).toEqual({ restartMode: 'fresh', warmupSavedUsd: null });
  });
});

describe('quotaWaitOf (#741)', () => {
  const round = (over: Partial<BoardCardRound>) =>
    ({
      phase: 'running',
      quotaLimit: 'session',
      quotaResetsAt: new Date('2026-10-21T15:00:00.000Z'),
      ...over,
    }) as BoardCardRound;

  it('names the limit and its reset while the round is active', () => {
    expect(quotaWaitOf(round({}))).toEqual({
      limit: 'session',
      resetsAt: '2026-10-21T15:00:00.000Z',
    });
    expect(quotaWaitOf(round({ quotaResetsAt: null }))).toEqual({
      limit: 'session',
      resetsAt: null,
    });
  });

  it('is null once the round is over, without a limit, or for a limit it does not know', () => {
    expect(quotaWaitOf(round({ phase: 'ended' }))).toBeNull();
    expect(quotaWaitOf(round({ quotaLimit: null }))).toBeNull();
    expect(quotaWaitOf(round({ quotaLimit: 'monthly' }))).toBeNull();
  });
});

describe('recommendationOf (#750 D1–D3, D5)', () => {
  const assessed = (over: Partial<BoardCard> = {}): CardWithRounds => ({
    ...card({
      recommendedModel: 'haiku',
      recommendedEffort: 'high',
      recommendedReason: 'A one-file change.',
      recommendedDesignModel: null,
      recommendedDesignReason: null,
      assessedAt: now,
      workClass: 'mechanical',
      workSignals: [],
      ...over,
    }),
    rounds: [],
  });

  it('keeps the assessment’s model and effort in the A arm, with the class', () => {
    expect(recommendationOf(assessed(), null).work).toEqual({
      model: 'haiku',
      effort: 'high',
      reason: 'A one-file change.',
      class: 'mechanical',
      signals: [],
    });
  });

  it('carries the mapped pair in the B arm, so the popover preselects the Run default', () => {
    expect(
      recommendationOf(assessed(), { workClass: 'mechanical' }).work,
    ).toMatchObject({ model: 'sonnet', effort: 'medium', class: 'mechanical' });
    expect(
      recommendationOf(
        assessed({ workClass: 'deciding', workSignals: ['auth', 'retired'] }),
        { workClass: 'deciding' },
      ).work,
    ).toMatchObject({
      model: 'opus',
      effort: 'high',
      class: 'deciding',
      signals: ['auth'],
    });
  });

  it('maps a stale class as unsure, and leaves no assessment as none', () => {
    expect(
      recommendationOf(assessed(), { workClass: null }).work,
    ).toMatchObject({ model: 'opus', effort: 'medium' });
    expect(
      recommendationOf(assessed({ recommendedModel: null }), {
        workClass: null,
      }).work,
    ).toBeNull();
  });
});

describe('escalationOf (#750 D9)', () => {
  it('is null until the card escalated', () => {
    expect(
      escalationOf(
        card({
          escalatedAt: null,
          escalationReason: null,
          escalationNote: null,
        }),
      ),
    ).toBeNull();
  });

  it('carries the reason, the note and when', () => {
    expect(
      escalationOf(
        card({
          escalatedAt: now,
          escalationReason: 'misclassified',
          escalationNote: 'Needs a schema decision.',
        }),
      ),
    ).toEqual({
      reason: 'misclassified',
      note: 'Needs a schema decision.',
      at: now.toISOString(),
    });
  });
});

describe('roundPushesOf (#837)', () => {
  const PR = 'https://github.com/acme/widget/pull/7';
  const sha = (c: string) => c.repeat(40);
  const pushed = (over: Partial<BoardCardRound> = {}) =>
    round({
      prNumber: 7,
      prUrl: PR,
      headSha: sha('a'),
      headAhead: 2,
      ciState: null,
      ciPassed: null,
      ciTotal: null,
      ...over,
    });
  const none = {
    prNumber: null,
    prUrl: null,
    headSha: null,
    headAhead: null,
    ciState: null,
    ciPassed: null,
    ciTotal: null,
  };

  it('gives a round that pushed nothing, or one from before #837, nulls', () => {
    expect(roundPushesOf([round(none)])).toEqual([
      { pullRequest: null, headSha: null, commits: null, ci: null },
    ]);
  });

  it("counts a round's commits from the head the round before it left on the PR", () => {
    const pushes = roundPushesOf([
      pushed({ headAhead: 2 }),
      round(none),
      pushed({ headSha: sha('b'), headAhead: 5 }),
      pushed({ prNumber: 8, prUrl: `${PR.slice(0, -1)}8`, headAhead: 1 }),
    ]);
    expect(pushes.map((p) => p.commits)).toEqual([2, null, 3, 1]);
    expect(pushes[2]?.pullRequest).toEqual({ number: 7, url: PR });
    expect(pushes[2]?.headSha).toBe(sha('b'));
  });

  it('leaves the count unknown when a head has no ahead, or it shrank', () => {
    const pushes = roundPushesOf([
      pushed({ headAhead: null }),
      pushed({ headSha: sha('b'), headAhead: 4 }),
      pushed({ headSha: sha('c'), headAhead: 1 }),
    ]);
    expect(pushes.map((p) => p.commits)).toEqual([null, null, null]);
  });

  it("shows the head's checks, linked to its checks page; none without any", () => {
    const [pending, passed, failed, noChecks] = roundPushesOf([
      pushed({ ciState: 'pending', ciPassed: 1, ciTotal: 3 }),
      pushed({ headSha: sha('b'), ciState: 'green', ciPassed: 4, ciTotal: 4 }),
      pushed({ headSha: sha('c'), ciState: 'red', ciPassed: 2, ciTotal: 4 }),
      pushed({ headSha: sha('d'), ciState: 'none', ciPassed: 0, ciTotal: 0 }),
    ]);
    expect(pending?.ci).toEqual({
      state: 'pending',
      passed: 1,
      total: 3,
      url: `https://github.com/acme/widget/commit/${sha('a')}/checks`,
    });
    expect(passed?.ci?.state).toBe('passed');
    expect(failed?.ci).toMatchObject({ state: 'failed', passed: 2, total: 4 });
    expect(noChecks?.ci).toBeNull();
  });
});

describe('takenOf (#845 D2, D10)', () => {
  const alive = { alive: new Set(['ses_live']) };

  it("is a bound card's session, its liveness and the branch it left", () => {
    expect(
      takenOf(
        card({
          source: 'manual',
          trackedSessionId: 'ses_live',
          takenBranch: 'feat/42-login',
        }),
        alive,
      ),
    ).toEqual({ sessionId: 'ses_live', alive: true, branch: 'feat/42-login' });
    expect(
      takenOf(
        card({
          source: 'captured',
          trackedSessionId: 'ses_gone',
          takenBranch: null,
        }),
        alive,
      ),
    ).toEqual({ sessionId: 'ses_gone', alive: false, branch: null });
  });

  it("is null for a session's own terminal card and an unbound card", () => {
    expect(
      takenOf(
        card({ source: 'terminal', trackedSessionId: 'ses_live' }),
        alive,
      ),
    ).toBeNull();
    expect(
      takenOf(card({ source: 'manual', trackedSessionId: null }), alive),
    ).toBeNull();
  });
});

describe('reviewOf (#884)', () => {
  const HEAD = 'a'.repeat(40);
  const NEXT = 'b'.repeat(40);
  const steps = [
    { id: 'peer', name: 'Peer review' },
    { id: 'sec', name: 'Security review' },
    { id: 'perf', name: 'Performance' },
  ];
  const reviewed = (
    over: Partial<BoardCard> = {},
    rounds: BoardCardRound[] = [],
  ) =>
    ({
      ...card({
        prNumber: 7,
        ciHeadSha: HEAD,
        reviewFixAttempts: 0,
        needsPerson: false,
        needsPersonReason: null,
        ...over,
      }),
      rounds,
    }) as CardWithRounds;
  const run = (over: Partial<CardReviewRunFact>): CardReviewRunFact => ({
    stepId: 'peer',
    prNumber: 7,
    headSha: HEAD,
    pass: 0,
    state: 'passed',
    blockingCount: 0,
    nitCount: 0,
    startedAt: new Date(now.getTime() - 60_000),
    ...over,
  });

  it('is null while review is off or no step is enabled', () => {
    expect(reviewOf(reviewed(), undefined, [])).toBeNull();
    expect(reviewOf(reviewed(), [], [])).toBeNull();
  });

  it('is idle with every step pending before CI is green', () => {
    expect(reviewOf(reviewed(), steps, [])).toEqual({
      state: 'idle',
      stepIndex: 0,
      stepCount: 3,
      fixRound: 0,
      fixLimit: 3,
      steps: steps.map((s) => ({
        id: s.id,
        name: s.name,
        state: 'pending',
        blockingCount: 0,
        nitCount: 0,
      })),
    });
  });

  it('names the running step and its index', () => {
    const view = reviewOf(reviewed(), steps, [
      run({ nitCount: 2 }),
      run({ stepId: 'sec', state: 'running' }),
    ]);
    expect(view).toMatchObject({
      state: 'running',
      currentStep: 'Security review',
      stepIndex: 1,
    });
    expect(view?.steps.map((s) => [s.state, s.nitCount])).toEqual([
      ['passed', 2],
      ['running', 0],
      ['pending', 0],
    ]);
  });

  it('is passed once every step passed on the head CI checked, nits allowed', () => {
    const runs = steps.map((s) => run({ stepId: s.id, nitCount: 1 }));
    expect(reviewOf(reviewed(), steps, runs)).toMatchObject({
      state: 'passed',
      stepIndex: 2,
    });
    expect(reviewOf(reviewed({ ciHeadSha: NEXT }), steps, runs)?.state).toBe(
      'idle',
    );
  });

  it('shows the blocked pass while its review_fix round works, with the round count', () => {
    const fixing = reviewed({ reviewFixAttempts: 1 }, [
      { trigger: 'review_fix', phase: 'running' } as BoardCardRound,
    ]);
    const view = reviewOf(fixing, steps, [
      run({}),
      run({ stepId: 'sec', state: 'blocked', blockingCount: 2 }),
      run({ stepId: 'perf' }),
    ]);
    expect(view).toMatchObject({ state: 'fixing', fixRound: 1, fixLimit: 3 });
    expect(view?.steps[1]).toMatchObject({
      state: 'blocked',
      blockingCount: 2,
    });
  });

  it('reads only the newest pass on the current PR', () => {
    const view = reviewOf(reviewed({ reviewFixAttempts: 1 }), steps, [
      run({ state: 'blocked', blockingCount: 1 }),
      run({ pass: 1, headSha: HEAD, state: 'running' }),
      run({ prNumber: 6, pass: 3, stepId: 'perf', state: 'failed' }),
    ]);
    expect(view?.steps.map((s) => s.state)).toEqual([
      'running',
      'pending',
      'pending',
    ]);
  });

  it('needs a person when the fix budget is spent or a step failed', () => {
    for (const reason of ['review_still_blocking', 'review_failed']) {
      expect(
        reviewOf(
          reviewed({ needsPerson: true, needsPersonReason: reason }),
          steps,
          [run({ state: 'failed' })],
        )?.state,
      ).toBe('needs_person');
    }
    expect(
      reviewOf(
        reviewed({ needsPerson: true, needsPersonReason: 'ci_still_failing' }),
        steps,
        [],
      )?.state,
    ).toBe('idle');
  });
});
