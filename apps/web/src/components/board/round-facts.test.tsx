import { describe, expect, test } from 'bun:test';
import type { CardRoundView } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { roundFacts } from '../../lib/board/round-facts';
import { RoundFacts, RoundSummary, RoundTokenSaver } from './round-facts';

const START = Date.parse('2026-10-20T10:00:00Z');
const at = (minutes: number) =>
  new Date(START + minutes * 60_000).toISOString();

const round = (extra: Partial<CardRoundView> = {}): CardRoundView => ({
  id: 'r1',
  round: 1,
  runId: 'run1',
  trigger: 'run',
  feedback: null,
  author: null,
  phase: 'finished',
  tmuxSession: null,
  finishedBy: null,
  summary: null,
  exitCode: null,
  error: null,
  hooksMissing: false,
  hooksCause: null,
  hooksProfile: null,
  wiring: null,
  wiringReason: null,
  costUsd: null,
  startedAt: at(0),
  waitingAt: null,
  backgroundAt: null,
  backgroundCommand: null,
  finishedAt: null,
  endedAt: null,
  ...extra,
});

const NOW = START + 90 * 60_000;

describe('Round facts (C-332)', () => {
  test('a finished round shows every fact that is present', () => {
    const html = renderToStaticMarkup(
      <RoundFacts
        now={NOW}
        round={round({
          model: 'claude-opus-5-5',
          effort: 'high',
          finishedAt: at(20),
          waitingAt: at(5),
          backgroundAt: at(8),
          costUsd: '1.5',
          tokenSaved: { estimateTokens: 12_300, estimateUsd: 0.41 },
          pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12' },
          commits: 2,
          headSha: 'abcdef0123456',
          ci: {
            state: 'passed',
            passed: 5,
            total: 5,
            url: 'https://github.com/o/r/commit/abcdef0/checks',
          },
          exitCode: 0,
          restartMode: 'resume',
          restartEstimate: {
            resumeTokens: 40_000,
            freshTokens: 9_000,
            cacheWarm: true,
          },
          warmupTokens: 3_000,
          warmupMs: 4_000,
        })}
      />,
    );
    expect(html).toContain('claude-opus-5-5 · high');
    expect(html).toContain('20 min 00 s');
    expect(html).toContain('Waiting');
    expect(html).toContain('15 min 00 s');
    expect(html).toContain('saved ≈ 12.3k tok');
    expect(html).toContain('$1.50');
    expect(html).toContain('#12 · 2 commits · abcdef0');
    expect(html).toContain('passed 5/5');
    expect(html).toContain('>0<');
    expect(html).toContain('resumed (≈ 40k tok in)');
    expect(html).toContain('3k tok · 4 s');
  });

  test('null fields are omitted, and a bare round shows only its duration', () => {
    const facts = roundFacts(round({ finishedAt: at(3) }), NOW);
    expect(facts.map((f) => f.key)).toEqual(['duration']);
    const html = renderToStaticMarkup(
      <RoundFacts now={NOW} round={round({ finishedAt: at(3) })} />,
    );
    for (const label of ['Model', 'Cost', 'CI', 'Exit code', 'Warm-up']) {
      expect(html).not.toContain(label);
    }
  });

  test('an in-progress round shows a running duration', () => {
    const facts = roundFacts(round({ phase: 'running' }), NOW);
    expect(facts[0]).toMatchObject({
      label: 'Running',
      value: '1 h 30 min',
    });
  });

  test('the breakdown is the saved line when there are filters', () => {
    const filters = [
      {
        filter: 'git',
        estimateTokens: 1_000,
        estimateUsd: 0.1,
        commands: 3,
        bypassed: 0,
        passedThrough: 0,
      },
    ] as unknown as CardRoundView['tokenSaverFilters'];
    const r = round({
      tokenSaved: { estimateTokens: 1_000, estimateUsd: 0.1 },
      tokenSaverFilters: filters,
    });
    expect(roundFacts(r, NOW).some((f) => f.key === 'saved')).toBe(false);
  });
});

describe('Round collapse toggles (C-332)', () => {
  const long = 'a line of the summary\n'.repeat(8);

  test('a long summary is clamped with "Show all"', () => {
    const html = renderToStaticMarkup(<RoundSummary text={long} />);
    expect(html).toContain('line-clamp-4');
    expect(html).toContain('Show all');
    expect(html).toContain('aria-expanded="false"');
  });

  test('an expanded summary is not clamped and offers "Show less"', () => {
    const html = renderToStaticMarkup(
      <RoundSummary text={long} defaultExpanded />,
    );
    expect(html).not.toContain('line-clamp-4');
    expect(html).toContain('Show less');
  });

  test('a short summary has no toggle', () => {
    const html = renderToStaticMarkup(<RoundSummary text="Done." />);
    expect(html).not.toContain('Show all');
    expect(html).not.toContain('line-clamp');
  });

  const saver = round({
    tokenSaved: { estimateTokens: 12_300, estimateUsd: 0.41 },
    tokenSaverFilters: [
      {
        filter: 'git-status',
        estimateTokens: 12_300,
        estimateUsd: 0.41,
        commands: 3,
        bypassed: 0,
        passedThrough: 0,
      },
    ] as unknown as CardRoundView['tokenSaverFilters'],
  });

  test('the token-saver breakdown folds behind one line and opens', () => {
    const closed = renderToStaticMarkup(<RoundTokenSaver round={saver} />);
    expect(closed).toContain('saved ≈ 12.3k tok');
    expect(closed).toContain('aria-expanded="false"');
    const open = renderToStaticMarkup(
      <RoundTokenSaver round={saver} defaultOpen />,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('git-status');
  });

  test('a round with no filters renders no token-saver block', () => {
    expect(renderToStaticMarkup(<RoundTokenSaver round={round()} />)).toBe('');
  });
});
