import { describe, expect, test } from 'bun:test';
import { BUILTIN_DESIGN_TEMPLATES } from '@nautelle/shared';
import { framesOf, revision } from './fixtures';
import {
  compareColumns,
  conformanceNote,
  frameKindLabel,
  templateOptions,
  templatesOf,
} from './templates';

describe('frameKindLabel (#833 D11)', () => {
  test('names a typed frame and leaves a legacy one bare', () => {
    expect(frameKindLabel({ kind: 'state_grid' })).toBe('State grid');
    expect(frameKindLabel({ kind: 'legacy' })).toBeNull();
  });
});

describe('conformanceNote', () => {
  test('no badge for a legacy revision or a conforming one', () => {
    expect(conformanceNote(null)).toBeNull();
    expect(
      conformanceNote({ ok: true, missing: [], extra: [], misplaced: [] }),
    ).toBeNull();
  });

  test('lists only the differences there are', () => {
    const note = conformanceNote({
      ok: false,
      missing: ['breakdown'],
      extra: [],
      misplaced: ['screen'],
    });
    expect(note?.lines).toEqual([
      { label: 'Missing', items: ['breakdown'] },
      { label: 'Out of order', items: ['screen'] },
    ]);
    expect(note?.tooManySteps).toBe(false);
  });

  test('too_many_steps is flagged for the split suggestion', () => {
    const note = conformanceNote({
      ok: false,
      missing: [],
      extra: [],
      misplaced: [],
      reason: 'too_many_steps',
    });
    expect(note?.tooManySteps).toBe(true);
  });
});

describe('compareColumns', () => {
  const frames = (id: string, n: number) =>
    framesOf(
      id,
      Array.from({ length: n }, (_, i) => `F${i}`),
    );
  const revisions = [
    revision({ id: 'a1', variant: 1, revision: 1, frames: frames('a1', 2) }),
    revision({ id: 'a2', variant: 1, revision: 2, frames: frames('a2', 2) }),
    revision({ id: 'b1', variant: 2, revision: 1, frames: frames('b1', 1) }),
  ];

  test('takes the latest revision of each variant at the same position', () => {
    const cols = compareColumns(revisions, [1, 2], 0);
    expect(cols.map((c) => c.revision.id)).toEqual(['a2', 'b1']);
    expect(cols.every((c) => c.frame?.position === 0)).toBe(true);
  });

  test('a variant without that position has no frame', () => {
    const cols = compareColumns(revisions, [1, 2], 1);
    expect(cols[0].frame?.name).toBe('F1');
    expect(cols[1].frame).toBeNull();
  });
});

describe('templatesOf (GET design/templates is { templates })', () => {
  test('reads the project list, built-ins plus custom', () => {
    const landing = { key: 'landing', name: 'Landing', frames: [] };
    const data = { templates: [...BUILTIN_DESIGN_TEMPLATES, landing] };
    expect(templateOptions(templatesOf(data)).map((o) => o.key)).toEqual([
      'page',
      'component',
      'flow',
      'landing',
    ]);
  });

  test('a bare array or no answer is not a response', () => {
    expect(templatesOf(undefined)).toBeNull();
    expect(templatesOf([] as unknown as { templates: never[] })).toBeNull();
  });
});

describe('templateOptions', () => {
  test('falls back to the built-ins', () => {
    expect(templateOptions(null).map((o) => o.key)).toEqual([
      'page',
      'component',
      'flow',
    ]);
  });
});
