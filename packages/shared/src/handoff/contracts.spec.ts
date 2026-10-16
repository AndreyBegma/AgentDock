import { describe, expect, it } from 'bun:test';
import {
  handoffNoteSchema,
  restartChipLabel,
  restartEstimateSchema,
  resumeContextArgsSchema,
  resumeContextResultSchema,
} from './contracts';
import { HANDOFF_NOTE_TEMPLATE } from './note';

const content = HANDOFF_NOTE_TEMPLATE.replace(
  '## Goal\n',
  '## Goal\nShip it.\n',
);

describe('handoffNoteSchema (#449 D5, D7)', () => {
  it('takes a valid note with fitting person lines', () => {
    expect(
      handoffNoteSchema.safeParse({
        content,
        personLines: [{ from: 2, to: 2 }],
      }).success,
    ).toBe(true);
  });

  it('refuses person lines past the end', () => {
    const parsed = handoffNoteSchema.safeParse({
      content,
      personLines: [{ from: 500, to: 500 }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].path).toEqual(['personLines']);
  });
});

describe('restartEstimateSchema', () => {
  it('is strict', () => {
    expect(
      restartEstimateSchema.safeParse({
        resumeTokens: 1,
        freshTokens: 2,
        cacheWarm: true,
      }).success,
    ).toBe(true);
    expect(
      restartEstimateSchema.safeParse({ resumeTokens: 1, freshTokens: 2 })
        .success,
    ).toBe(false);
  });
});

describe('restartChipLabel (#449 D9)', () => {
  it('labels a fresh start with the saving', () => {
    expect(restartChipLabel('fresh', '1.234')).toBe(
      'resumed from handoff · saved ≈ $1.23',
    );
  });

  it('drops a missing or non-positive saving', () => {
    expect(restartChipLabel('fresh', null)).toBe('resumed from handoff');
    expect(restartChipLabel('fresh', '0')).toBe('resumed from handoff');
    expect(restartChipLabel('fresh', 'nan')).toBe('resumed from handoff');
  });

  it('labels a resume, and nothing for a first round or none', () => {
    expect(restartChipLabel('resume', '9')).toBe('resumed session');
    expect(restartChipLabel('first', null)).toBeNull();
    expect(restartChipLabel(undefined, undefined)).toBeNull();
  });
});

describe('resume_context (#449 D6)', () => {
  it('takes no argument', () => {
    expect(resumeContextArgsSchema.safeParse({}).success).toBe(true);
    expect(resumeContextArgsSchema.safeParse({ card: 12 }).success).toBe(false);
  });

  it('returns the note, or why there is none', () => {
    const ok = (r: unknown) => resumeContextResultSchema.safeParse(r).success;
    expect(
      ok({
        found: true,
        card: { number: 12, label: 'C-12' },
        content,
        personLines: [],
        updatedBy: 'haiku',
        updatedAt: '2026-10-16T10:00:00.000Z',
      }),
    ).toBe(true);
    expect(ok({ found: false, reason: 'no_note' })).toBe(true);
    expect(ok({ found: false, reason: 'offline' })).toBe(false);
    expect(ok({ found: true, card: { number: 12, label: 'C-12' } })).toBe(
      false,
    );
  });
});
