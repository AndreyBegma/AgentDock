import { CARD_HOOKS_GRACE_MS } from '@agentdock/shared';
import type { ProfileAgentdock } from '@agentdock/shared/protocol';
import type { BoardCard, BoardCardRound } from '@prisma/client';
import { type CardFacts, hooksCauseOf } from './board-mapper';

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
