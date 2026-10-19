import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptySummary } from '../../lib/token-saver/summary';
import {
  CostPerRoundTable,
  CostPerRoundWeeksTable,
  UnmeasuredKindsNote,
} from './cost-per-round';
import { DescriptionIncompleteBadge } from './description-incomplete-badge';
import { FilterBreakdown } from './filter-breakdown';
import { SavedBadge } from './saved-badge';
import {
  PromptCacheTable,
  UnfilteredProgramTable,
  UnfilteredReasonTable,
} from './summary-tables';
import { PromptCacheTile, SummaryTiles } from './summary-tiles';

describe('SavedBadge (#445 D13)', () => {
  test('shows "saved ≈ $x" with the tokens behind it', () => {
    const html = renderToStaticMarkup(
      <SavedBadge saved={{ estimateUsd: 0.41, estimateTokens: 90_000 }} />,
    );
    expect(html).toContain('saved ≈ $0.41');
    expect(html).toContain('90');
    expect(html).toContain('estimate');
  });

  test('renders nothing without a saving', () => {
    expect(renderToStaticMarkup(<SavedBadge saved={null} />)).toBe('');
    expect(renderToStaticMarkup(<SavedBadge saved={undefined} />)).toBe('');
    expect(
      renderToStaticMarkup(
        <SavedBadge saved={{ estimateUsd: 0, estimateTokens: 0 }} />,
      ),
    ).toBe('');
  });
});

describe('DescriptionIncompleteBadge (#445 D8)', () => {
  test('names the state when the guard let it through incomplete', () => {
    const html = renderToStaticMarkup(
      <DescriptionIncompleteBadge incomplete />,
    );
    expect(html).toContain('Description incomplete');
  });

  test('is absent otherwise, and for an old card without the field', () => {
    expect(
      renderToStaticMarkup(<DescriptionIncompleteBadge incomplete={false} />),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        <DescriptionIncompleteBadge incomplete={undefined} />,
      ),
    ).toBe('');
  });
});

describe('FilterBreakdown (#445 D13)', () => {
  const filters = [
    {
      filter: 'js/jest',
      estimateUsd: 0.3,
      estimateTokens: 60_000,
      commands: 4,
      bypassed: 1,
      passedThrough: 0,
    },
    {
      filter: 'none',
      estimateUsd: 0,
      estimateTokens: 0,
      commands: 1,
      bypassed: 0,
      passedThrough: 1,
    },
  ];

  test('lists each filter with its saving and counts, in the order given', () => {
    const html = renderToStaticMarkup(<FilterBreakdown filters={filters} />);
    expect(html.indexOf('js/jest')).toBeLessThan(
      html.indexOf('runner too old to say why'),
    );
    expect(html).toContain('≈ $0.30');
    expect(html).toContain('4 commands');
    expect(html).toContain('1 raw');
    expect(html).toContain('1 unchanged');
    expect(html).toContain('1 command ·');
  });

  test('names why no filter ran (amendment 12)', () => {
    const passed = { ...filters[1], passedThrough: 1 };
    const html = renderToStaticMarkup(
      <FilterBreakdown
        filters={[
          { ...passed, filter: 'none:compound' },
          { ...passed, filter: 'none:uncovered' },
          { ...passed, filter: 'none:mode' },
        ]}
      />,
    );
    expect(html).toContain('Compound command (not filtered)');
    expect(html).toContain('No filter for this command');
    expect(html).toContain('Not filtered in this permission mode');
  });

  test('renders nothing for a round without filtered commands', () => {
    expect(renderToStaticMarkup(<FilterBreakdown filters={[]} />)).toBe('');
    expect(renderToStaticMarkup(<FilterBreakdown filters={undefined} />)).toBe(
      '',
    );
  });
});

describe('SummaryTiles', () => {
  const summary = {
    ...emptySummary('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    totals: {
      estimateUsd: 12.5,
      estimateTokens: 2_500_000,
      commands: 200,
      rawBytes: 10_000,
      keptBytes: 1_000,
    },
    bypassRate: 0.05,
    passThroughRate: 0.2,
  };

  test('shows the saving, the commands and both rates', () => {
    const html = renderToStaticMarkup(<SummaryTiles summary={summary} />);
    expect(html).toContain('≈ $12.50');
    expect(html).toContain('200');
    expect(html).toContain('5%');
    expect(html).toContain('20%');
    expect(html).toContain('10%'); // agents read 10% of the original
  });

  test('a range without commands shows dashes, not zero rates', () => {
    const html = renderToStaticMarkup(
      <SummaryTiles
        summary={emptySummary(
          '2026-10-01T00:00:00.000Z',
          '2026-11-01T00:00:00.000Z',
        )}
      />,
    );
    expect(html).toContain('No filtered command in this range');
    expect(html).not.toContain('0%');
  });
});

describe('the unfiltered breakdown (#648)', () => {
  const none = (filter: string, commands: number) => ({
    filter,
    estimateUsd: 0,
    estimateTokens: 0,
    commands,
    bypassed: 0,
    passedThrough: commands,
  });

  test('a row per reason, the legacy one named as an old runner', () => {
    const html = renderToStaticMarkup(
      <UnfilteredReasonTable
        filters={[none('none', 3), none('none:uncovered', 1)]}
      />,
    );
    expect(html).toContain('Compound command (not filtered)');
    expect(html).toContain('No filter for this command');
    expect(html).toContain('Not filtered in this permission mode');
    expect(html).toContain('No filter (runner too old to say why)');
    expect(html).toContain('Filter switched off for this launch');
    expect(html).toContain('75%');
  });

  test('lists the programs with their command counts', () => {
    const html = renderToStaticMarkup(
      <UnfilteredProgramTable
        programs={[
          { program: 'git log', commands: 12 },
          { program: 'ls', commands: 4 },
        ]}
        empty={<p>none</p>}
      />,
    );
    expect(html).toContain('git log');
    expect(html).toContain('12');
    expect(
      renderToStaticMarkup(
        <UnfilteredProgramTable programs={[]} empty={<p>none</p>} />,
      ),
    ).toBe('<p>none</p>');
  });
});

describe('the prompt cache (#648)', () => {
  const summary = {
    ...emptySummary('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
    promptCache: [
      {
        runKind: 'card' as const,
        runs: 2,
        input: 1_000,
        cacheRead: 8_000,
        cacheWrite: 1_000,
      },
    ],
  };

  test('the tile shows the measured read share and input per run', () => {
    const html = renderToStaticMarkup(<PromptCacheTile summary={summary} />);
    expect(html).toContain('80%');
    expect(html).toContain('5k input tokens per run');
  });

  test('the tile shows a dash without runs', () => {
    const html = renderToStaticMarkup(
      <PromptCacheTile
        summary={emptySummary(
          '2026-10-01T00:00:00.000Z',
          '2026-11-01T00:00:00.000Z',
        )}
      />,
    );
    expect(html).toContain('No ended run with usage in this range');
  });

  test('the table has a row per run kind', () => {
    const html = renderToStaticMarkup(
      <PromptCacheTable rows={summary.promptCache} empty={null} />,
    );
    expect(html).toContain('Card worker');
    expect(html).toContain('80%');
    expect(html).toContain('5k');
  });
});

describe('cost per round (#663 D5)', () => {
  const row = (week: string, medianUsd: string) => ({
    sessionKind: 'ci_fix' as const,
    week,
    rounds: 4,
    pricedRounds: 4,
    medianUsd,
    p90Usd: '3.000000',
    cacheReadShare: 0.97,
    medianPeakContext: 148_000,
    medianTurns: 12.5,
  });

  test('leads with the newest week per kind and the change since the first', () => {
    const html = renderToStaticMarkup(
      <CostPerRoundTable
        rows={[row('2026-10-05', '2.000000'), row('2026-10-12', '1.500000')]}
        empty={<p>none</p>}
      />,
    );
    expect(html).toContain('CI-fix round');
    expect(html).toContain('Week of Oct 12');
    expect(html).toContain('$1.50');
    expect(html).toContain('$3.00');
    expect(html).toContain('97%');
    expect(html).toContain('148k');
    expect(html).toContain('12.5');
    expect(html).toContain('−25%');
  });

  test('shows the empty state with no round, and every week in the weekly table', () => {
    expect(
      renderToStaticMarkup(
        <CostPerRoundTable rows={[]} empty={<p>no rounds</p>} />,
      ),
    ).toBe('<p>no rounds</p>');
    const weeks = renderToStaticMarkup(
      <CostPerRoundWeeksTable
        rows={[row('2026-10-05', '2.000000'), row('2026-10-12', '1.500000')]}
      />,
    );
    expect(weeks).toContain('Week of Oct 5');
    expect(weeks).toContain('Week of Oct 12');
  });

  test('names the launches it cannot measure', () => {
    const html = renderToStaticMarkup(<UnmeasuredKindsNote />);
    expect(html).toContain('skill runs');
    expect(html).toContain('model assessments');
  });
});
