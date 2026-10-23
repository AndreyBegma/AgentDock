import { CARD_HOOKS_GRACE_MS, type StewardCardChip } from '@nautelle/shared';
import type { ProfileAgentdock } from '@nautelle/shared/protocol';
import type { BoardCard, BoardCardRound } from '@prisma/client';
import {
  type CardFacts,
  type CardWithRounds,
  escalationOf,
  hooksCauseOf,
  quotaWaitOf,
  recommendationOf,
  restartOf,
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
