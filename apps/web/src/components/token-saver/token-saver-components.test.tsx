import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptySummary } from '../../lib/token-saver/summary';
import { DescriptionIncompleteBadge } from './description-incomplete-badge';
import { FilterBreakdown } from './filter-breakdown';
import { SavedBadge } from './saved-badge';
import { SummaryTiles } from './summary-tiles';

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
    expect(html.indexOf('js/jest')).toBeLessThan(html.indexOf('uncovered'));
    expect(html).toContain('≈ $0.30');
    expect(html).toContain('4 commands');
    expect(html).toContain('1 raw');
    expect(html).toContain('1 unchanged');
    expect(html).toContain('1 command ·');
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
