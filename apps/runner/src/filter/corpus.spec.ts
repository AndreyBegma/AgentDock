import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CorpusCase,
  loadCorpus,
  runCorpusCase,
  SAVINGS_CEILING,
  SAVINGS_CEILINGS,
  savingsMedian,
} from './corpus';
import { ALL_FILTERS, FAMILIES } from './families';
import { demoFilter, lossyFilter, tapOutput } from './testing';

/**
 * The regression corpus (#445 D4d) and the savings criteria. Each family's
 * cases live in `families/<family>/corpus/`; this file runs them all against
 * the registry, so a family slot adds cases and nothing else.
 */

const familyCorpus = (family: string) =>
  loadCorpus(join(import.meta.dir, 'families', family, 'corpus'));

describe.each(Object.keys(FAMILIES))('corpus: %s family', (family) => {
  const cases = familyCorpus(family);
  const results = cases.map((c) => runCorpusCase(ALL_FILTERS, c));

  it('keeps every error, failure, warning and stack line of every case', () => {
    for (const r of results) {
      expect({ case: r.case.name, missing: r.missing }).toEqual({
        case: r.case.name,
        missing: [],
      });
    }
  });

  it('filters every case marked `expect: filtered`', () => {
    for (const r of results.filter((x) => x.case.expect === 'filtered')) {
      expect({ case: r.case.name, filtered: r.filtered }).toEqual({
        case: r.case.name,
        filtered: true,
      });
    }
  });

  it('keeps every case with a `maxRatio` at or under it', () => {
    for (const r of results.filter((x) => x.case.maxRatio !== undefined)) {
      expect({
        case: r.case.name,
        within: r.ratio <= (r.case.maxRatio ?? 1),
      }).toEqual({ case: r.case.name, within: true });
    }
  });

  // Test runners and type checkers, each against its own ceiling.
  it.each(
    (['test', 'typecheck'] as const).flatMap((category) =>
      (['failing', 'passing'] as const).map(
        (outcome) => [category, outcome] as const,
      ),
    ),
  )('median kept/raw, %s %s', (category, outcome) => {
    const value = savingsMedian(results, outcome, category);
    if (value !== null) {
      expect(value).toBeLessThanOrEqual(SAVINGS_CEILINGS[category][outcome]);
    }
  });
});

describe('the corpus harness itself', () => {
  const fixtures = loadCorpus(join(import.meta.dir, 'fixtures', 'corpus'));

  it('loads cases from json + out pairs', () => {
    expect(fixtures.map((c) => c.name)).toEqual([
      'demo-failing',
      'demo-unclassified',
    ]);
    expect(fixtures[0]).toMatchObject({
      argv: ['demo-test', '--all'],
      exitCode: 1,
      category: 'test',
      outcome: 'failing',
      expect: 'filtered',
    });
  });

  it('filters a case, keeping its failure and stack lines', () => {
    const [failing, unclassified] = fixtures.map((c) =>
      runCorpusCase([demoFilter], c),
    );
    expect(failing?.filtered).toBe(true);
    expect(failing?.missing).toEqual([]);
    expect(failing?.kept).toContain('at dropOldest (src/spool.ts:212:11)');
    expect(unclassified?.filtered).toBe(false);
    expect(unclassified?.kept).toBe('demo-test 4.2.0\n');
  });

  it('catches a filter that would lose a line, by returning the original', () => {
    const lossy = { ...lossyFilter, matches: () => true };
    const [failing] = fixtures.map((c) => runCorpusCase([lossy], c));
    expect(failing?.filtered).toBe(false);
    expect(failing?.missing).toEqual([]);
  });

  it('reads `maxRatio`, and refuses one outside (0, 1]', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    try {
      const write = (maxRatio: unknown) => {
        writeFileSync(
          join(dir, 'c.json'),
          JSON.stringify({
            argv: ['demo-test'],
            exitCode: 0,
            category: 'other',
            outcome: 'passing',
            maxRatio,
          }),
        );
        writeFileSync(join(dir, 'c.out'), 'ok\n');
      };
      write(0.5);
      expect(loadCorpus(dir)[0]?.maxRatio).toBe(0.5);
      write(1.5);
      expect(() => loadCorpus(dir)).toThrow('malformed');
      write('0.5');
      expect(() => loadCorpus(dir)).toThrow('malformed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes the savings medians the acceptance criteria name', () => {
    const make = (
      name: string,
      output: string,
      outcome: CorpusCase['outcome'],
    ): CorpusCase => ({
      name,
      argv: ['demo-test'],
      exitCode: outcome === 'failing' ? 1 : 0,
      category: 'test',
      outcome,
      expect: 'filtered',
      output,
    });
    const results = [
      make('p1', tapOutput(300), 'passing'),
      make('p2', tapOutput(500), 'passing'),
      make(
        'f1',
        tapOutput(300, ['not ok 301 - x', '  Error: boom']),
        'failing',
      ),
    ].map((c) => runCorpusCase([demoFilter], c));
    for (const outcome of ['passing', 'failing'] as const) {
      expect(savingsMedian(results, outcome)).toBeLessThanOrEqual(
        SAVINGS_CEILING[outcome],
      );
    }
    expect(savingsMedian([], 'failing')).toBeNull();
    expect(savingsMedian(results, 'failing', 'typecheck')).toBeNull();
    expect(savingsMedian(results, 'failing', 'test')).toBeGreaterThan(0);
  });
});
