import { describe, expect, it } from 'bun:test';
import {
  HANDOFF_PERSON_MARK,
  handoffPersonLinesSchema,
  linesOfRanges,
  markPersonEdit,
  markPersonLines,
  personLinesFit,
  personLinesKept,
  personLineTexts,
  rangesOfLines,
  splitPersonMarks,
} from './person-lines';

const lines = (...l: string[]) => l.join('\n');

describe('person line ranges (#449 D7)', () => {
  it('builds sorted, apart ranges from line numbers', () => {
    expect(rangesOfLines([5, 1, 2, 3, 7, 2])).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 },
      { from: 7, to: 7 },
    ]);
    expect(linesOfRanges([{ from: 2, to: 4 }])).toEqual([2, 3, 4]);
  });

  it('accepts only sorted, apart ranges', () => {
    const ok = (r: unknown) => handoffPersonLinesSchema.safeParse(r).success;
    expect(ok([])).toBe(true);
    expect(
      ok([
        { from: 1, to: 2 },
        { from: 4, to: 4 },
      ]),
    ).toBe(true);
    expect(
      ok([
        { from: 1, to: 2 },
        { from: 3, to: 4 },
      ]),
    ).toBe(false);
    expect(
      ok([
        { from: 4, to: 4 },
        { from: 1, to: 2 },
      ]),
    ).toBe(false);
    expect(ok([{ from: 3, to: 2 }])).toBe(false);
    expect(ok([{ from: 0, to: 2 }])).toBe(false);
  });

  it('checks the ranges fit the content', () => {
    expect(personLinesFit('a\nb', [{ from: 2, to: 2 }])).toBe(true);
    expect(personLinesFit('a\nb', [{ from: 2, to: 3 }])).toBe(false);
  });
});

describe('markPersonEdit', () => {
  const prev = lines('## Next', '1. tests', '2. docs', '', '## Done', 'x');

  it('marks lines the person added or changed, not blank ones', () => {
    const edited = lines(
      '## Next',
      '1. tests — cover the oversize note',
      '2. docs',
      '',
      'Do not touch the runner.',
      '',
      '## Done',
      'x',
    );
    expect(markPersonEdit(prev, [], edited)).toEqual([
      { from: 2, to: 2 },
      { from: 5, to: 5 },
    ]);
  });

  it('keeps earlier person lines that the edit kept, at their new place', () => {
    const before = markPersonEdit(prev, [], lines('Stay on develop.', prev));
    expect(before).toEqual([{ from: 1, to: 1 }]);
    const withPerson = lines('Stay on develop.', prev);
    const edited = lines(
      'Stay on develop.',
      '',
      prev.replace('2. docs', '2. docs, then the guide'),
    );
    expect(markPersonEdit(withPerson, before, edited)).toEqual([
      { from: 1, to: 1 },
      { from: 5, to: 5 },
    ]);
  });

  it('marks nothing when nothing changed', () => {
    expect(markPersonEdit(prev, [], prev)).toEqual([]);
  });

  it('drops a person line the person removed', () => {
    const withPerson = lines('Stay on develop.', prev);
    expect(markPersonEdit(withPerson, [{ from: 1, to: 1 }], prev)).toEqual([]);
  });
});

describe('personLinesKept', () => {
  const prev = lines('## Next', 'Do not touch the runner.', '1. tests');
  const ranges = [{ from: 2, to: 2 }];

  it('finds the person lines in the rewrite and reports where they are', () => {
    const next = lines(
      '## Next',
      '1. docs',
      'Do not touch the runner.  ',
      '2. tests',
    );
    expect(personLinesKept(prev, ranges, next)).toEqual({
      ok: true,
      personLines: [{ from: 3, to: 3 }],
    });
  });

  it('names a person line the rewrite dropped or changed', () => {
    const next = lines('## Next', 'Avoid the runner.', '1. tests');
    expect(personLinesKept(prev, ranges, next)).toEqual({
      ok: false,
      missing: ['Do not touch the runner.'],
    });
  });

  it('wants them in order', () => {
    const two = lines('A first.', 'B second.');
    expect(
      personLinesKept(two, [{ from: 1, to: 2 }], lines('B second.', 'A first.'))
        .ok,
    ).toBe(false);
  });

  it('passes trivially with no person lines', () => {
    expect(personLinesKept(prev, [], 'anything')).toEqual({
      ok: true,
      personLines: [],
    });
  });
});

describe('markPersonLines / splitPersonMarks', () => {
  const content = lines(
    '## Next',
    'Do not touch the runner.',
    '',
    'And keep CI green.',
    '1. tests',
  );
  const ranges = [{ from: 2, to: 4 }];

  it('marks the non-blank person lines on disk', () => {
    const marked = markPersonLines(content, ranges);
    expect(marked.split('\n')[1]).toBe(
      `Do not touch the runner.${HANDOFF_PERSON_MARK}`,
    );
    expect(marked.split('\n')[2]).toBe('');
    expect(personLineTexts(content, ranges)).toEqual([
      'Do not touch the runner.',
      'And keep CI green.',
    ]);
  });

  it('round-trips to the content and the non-blank ranges', () => {
    expect(splitPersonMarks(markPersonLines(content, ranges))).toEqual({
      content,
      personLines: [
        { from: 2, to: 2 },
        { from: 4, to: 4 },
      ],
    });
  });

  it('reads a mark the agent left with trailing spaces', () => {
    expect(splitPersonMarks('a <!-- person -->  \nb')).toEqual({
      content: 'a\nb',
      personLines: [{ from: 1, to: 1 }],
    });
  });
});
