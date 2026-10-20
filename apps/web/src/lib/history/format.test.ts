import { describe, expect, test } from 'bun:test';
import { RUN_KINDS, RUN_STATUSES, type RunUsage } from '@agentdock/shared';
import {
  abandonedHiddenLabel,
  costLabel,
  hasRunFilters,
  historyRedirectTarget,
  latestSession,
  NO_RUN_FILTERS,
  parseRunUpdate,
  prLabel,
  RUN_CHIP_DEFS,
  RUN_KIND_LABEL,
  RUN_STATUS_CHIPS,
  RUN_STATUS_LABEL,
  retryHref,
  runFacts,
  runFailure,
  runFiltersFromSearch,
  runFiltersSearch,
  runHref,
  runLabel,
  runsHref,
  runTitle,
  runtimeLabel,
  splitAbandoned,
  tokensLabel,
  toRunQuery,
  totalRuns,
} from './format';

describe('RUN_STATUS_LABEL', () => {
  test('is sentence case, as every pill label', () => {
    for (const status of RUN_STATUSES) {
      const label = RUN_STATUS_LABEL[status];
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });
});

describe('runTitle', () => {
  const base = { issue: null, slot: null, title: null, kind: 'skill' } as const;
  test('own title wins', () => {
    expect(runTitle({ ...base, title: '  Estimate  ' })).toBe('Estimate');
  });
  test('falls back to issue and slot, then to the kind', () => {
    expect(runTitle({ ...base, issue: 155, slot: 'i155' })).toBe('#155 · i155');
    expect(runTitle(base)).toBe(RUN_KIND_LABEL.skill);
  });
});

describe('splitAbandoned', () => {
  const runs = [
    { status: 'succeeded' },
    { status: 'abandoned' },
    { status: 'abandoned' },
  ] as const;
  test('hides abandoned and counts them', () => {
    const { visible, hidden } = splitAbandoned(runs, false);
    expect(visible).toHaveLength(1);
    expect(hidden).toBe(2);
  });
  test('shows everything when asked', () => {
    expect(splitAbandoned(runs, true)).toEqual({
      visible: [...runs],
      hidden: 0,
    });
  });
  test('the sentence agrees in number', () => {
    expect(abandonedHiddenLabel(1)).toBe('1 abandoned run hidden');
    expect(abandonedHiddenLabel(43)).toBe('43 abandoned runs hidden');
  });
});

const usage = (patch: Partial<RunUsage> = {}): RunUsage => ({
  input: 1000,
  output: 500,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  requests: 3,
  costUsd: '1.5',
  unpricedRequests: 0,
  ...patch,
});

describe('run kinds and filters', () => {
  test('every kind has a label without underscores', () => {
    for (const kind of RUN_KINDS) {
      expect(RUN_KIND_LABEL[kind]).not.toContain('_');
    }
  });

  const parse = (search: string) =>
    runFiltersFromSearch(new URLSearchParams(search));

  test('a ?kind= link opens the filter; an unknown kind is ignored', () => {
    expect(parse('kind=skill').kind).toBe('skill');
    expect(parse('kind=nonsense').kind).toBe('');
    expect(parse('')).toEqual(NO_RUN_FILTERS);
  });

  test('the URL round-trips, in a stable order, and drops a bad date', () => {
    const filters = parse('to=2026-10-14&status=failed&from=2026-10-01');
    expect(runFiltersSearch(filters)).toBe(
      '?status=failed&from=2026-10-01&to=2026-10-14',
    );
    expect(parse('from=yesterday').from).toBe('');
    expect(runFiltersSearch(NO_RUN_FILTERS)).toBe('');
  });

  test('the kind filter reaches the query', () => {
    expect(toRunQuery({ ...NO_RUN_FILTERS, kind: 'skill' }).kind).toBe('skill');
  });

  test('no filter set is "nothing yet", any filter set is "no matches"', () => {
    expect(hasRunFilters(NO_RUN_FILTERS)).toBe(false);
    expect(hasRunFilters({ ...NO_RUN_FILTERS, status: 'failed' })).toBe(true);
  });

  test('status has its own chips, so it is not a removable toolbar chip', () => {
    expect(RUN_CHIP_DEFS.map((d) => d.key)).toEqual(['kind', 'from', 'to']);
    expect(RUN_STATUS_CHIPS).toContain('failed');
    expect([...RUN_STATUS_CHIPS].sort()).toEqual([...RUN_STATUSES].sort());
  });

  test('the All chip counts every status', () => {
    expect(
      totalRuns({
        running: 2,
        blocked: 1,
        waiting_person: 0,
        succeeded: 4,
        failed: 3,
        abandoned: 5,
      }),
    ).toBe(15);
  });
});

describe('the Runs tab of Activity (C-285)', () => {
  test('the tab carries the filters it is given, in a stable order', () => {
    expect(runsHref('p1')).toBe('/projects/p1/activity?tab=runs');
    expect(runsHref('p1', { status: 'failed', kind: 'skill' })).toBe(
      '/projects/p1/activity?tab=runs&kind=skill&status=failed',
    );
  });

  test("a row carries History's columns and leaves the empty ones out", () => {
    const usage: RunUsage = {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      costUsd: null,
      unpricedRequests: 0,
    };
    expect(
      runFacts({
        kind: 'skill',
        runtime: null,
        model: null,
        prNumber: null,
        prChecks: null,
        durationMs: null,
        usage,
      }),
    ).toBe(RUN_KIND_LABEL.skill);
    const facts = runFacts({
      kind: 'orchestrator_slot',
      runtime: 'claude',
      model: 'opus',
      prNumber: 9,
      prChecks: null,
      durationMs: 65_000,
      usage: { ...usage, requests: 2, input: 1200, costUsd: '0.5' },
    });
    expect(facts).toContain('claude / opus');
    expect(facts).toContain('PR #9');
    expect(facts).toContain('tokens');
    expect(facts.split(' · ')).toHaveLength(6);
  });

  test('a run opens beside the tab', () => {
    expect(runHref('p1', 'r1')).toBe('/projects/p1/activity?tab=runs&run=r1');
  });

  test('an old /history link keeps its filters and drops the unknown ones', () => {
    expect(
      historyRedirectTarget('p1', {
        kind: 'skill',
        from: ['2026-10-01', '2026-10-02'],
        status: 'nonsense',
        other: 'x',
      }),
    ).toBe('/projects/p1/activity?tab=runs&kind=skill&from=2026-10-01');
  });

  test('an old /history/:runId link opens that run', () => {
    expect(historyRedirectTarget('p1', {}, 'r1')).toBe(
      '/projects/p1/activity?tab=runs&run=r1',
    );
  });
});

describe('runFailure', () => {
  const run = {
    kind: 'plan',
    status: 'failed',
    outcome: null,
    prNumber: null,
  } as const;

  test('a fine run has no banner', () => {
    expect(runFailure({ ...run, status: 'running' })).toBeNull();
    expect(runFailure({ ...run, status: 'succeeded' })).toBeNull();
  });

  test('a failed run leads with the runner’s words', () => {
    expect(
      runFailure({ ...run, outcome: 'plan.turn failed: timeout' }),
    ).toMatchObject({
      tone: 'danger',
      cause: 'plan.turn failed: timeout',
      updateRunner: false,
    });
    expect(runFailure(run)?.cause).toBe('The runner reported no reason.');
  });

  test('unknown_command asks for a runner update', () => {
    expect(
      runFailure({
        ...run,
        outcome:
          'plan.turn failed on the runner: unknown_command — unknown command: plan.turn',
      })?.updateRunner,
    ).toBe(true);
  });

  test('a slot run fails on its closed PR', () => {
    expect(
      runFailure({ ...run, kind: 'orchestrator_slot', prNumber: 205 })?.cause,
    ).toBe('Pull request #205 was closed without being merged.');
  });

  test('blocked carries the worker’s checkpoint', () => {
    expect(
      runFailure({
        ...run,
        kind: 'orchestrator_slot',
        status: 'blocked',
        outcome: 'needs a grant',
      }),
    ).toMatchObject({ tone: 'warn', cause: 'needs a grant' });
  });
});

describe('retryHref', () => {
  const base = { status: 'failed', planId: null, title: null } as const;
  test('a planner run retries in its plan', () => {
    expect(retryHref('p1', { ...base, kind: 'plan', planId: 'pl1' })).toBe(
      '/projects/p1/planner/pl1',
    );
  });
  test('a skill run reopens the skill’s run dialog', () => {
    expect(
      retryHref('p1', { ...base, kind: 'skill', title: '/cs-review' }),
    ).toBe('/projects/p1/skills?run=cs-review');
  });
  test('a slot run and a running run have no retry', () => {
    expect(retryHref('p1', { ...base, kind: 'orchestrator_slot' })).toBeNull();
    expect(
      retryHref('p1', {
        ...base,
        kind: 'plan',
        planId: 'pl1',
        status: 'running',
      }),
    ).toBeNull();
  });
});

describe('latestSession', () => {
  test('picks the newest start, none for none', () => {
    expect(
      latestSession([
        { id: 'a', startedAt: '2026-10-14T10:00:00.000Z' },
        { id: 'b', startedAt: '2026-10-14T11:00:00.000Z' },
      ])?.id,
    ).toBe('b');
    expect(latestSession([])).toBeNull();
  });
});

describe('costLabel', () => {
  test('priced', () => {
    expect(costLabel(usage())).toBe('$1.50');
  });
  test('null cost with requests is unpriced, not zero', () => {
    expect(costLabel(usage({ costUsd: null, unpricedRequests: 3 }))).toBe(
      'unpriced',
    );
  });
  test('partly priced says how many are missing', () => {
    expect(costLabel(usage({ unpricedRequests: 2 }))).toBe(
      '$1.50 + 2 unpriced',
    );
  });
  test('no requests at all is a dash', () => {
    expect(costLabel(usage({ requests: 0, costUsd: null }))).toBe('—');
  });
});

describe('tokensLabel', () => {
  test('sums every bucket', () => {
    expect(tokensLabel(usage({ cacheRead: 500 }))).toBe('2k');
  });
  test('no requests is a dash', () => {
    expect(tokensLabel(usage({ requests: 0 }))).toBe('—');
  });
});

describe('labels', () => {
  test('run label: issue and slot, else title', () => {
    expect(runLabel({ issue: 42, slot: 'i42', title: null })).toBe('#42 · i42');
    expect(runLabel({ issue: null, slot: null, title: 'Nightly' })).toBe(
      'Nightly',
    );
  });
  test('runtime / model', () => {
    expect(runtimeLabel({ runtime: 'claude', model: 'opus' })).toBe(
      'claude / opus',
    );
    expect(runtimeLabel({ runtime: null, model: null })).toBe('—');
  });
  test('PR with and without checks', () => {
    expect(prLabel({ prNumber: null, prChecks: null })).toBe('—');
    expect(prLabel({ prNumber: 9, prChecks: null })).toBe('PR #9');
    expect(prLabel({ prNumber: 9, prChecks: 'green' })).toContain('PR #9 · ');
  });
});

describe('toRunQuery / parseRunUpdate', () => {
  test('a status reaches the query; a bad one never gets past the URL', () => {
    expect(toRunQuery({ ...NO_RUN_FILTERS, status: 'failed' })).toEqual({
      status: 'failed',
    });
    expect(
      toRunQuery(runFiltersFromSearch(new URLSearchParams('status=nope'))),
    ).toEqual({});
  });
  test('run.updated payload', () => {
    expect(parseRunUpdate({ id: 'r1', status: 'running' })).toEqual({
      id: 'r1',
      status: 'running',
    });
    expect(parseRunUpdate({ id: 'r1', status: 'x' })).toBeNull();
    expect(parseRunUpdate(null)).toBeNull();
  });
});
