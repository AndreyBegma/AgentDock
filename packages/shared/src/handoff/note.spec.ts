import { describe, expect, it } from 'bun:test';
import {
  estimateHandoffTokens,
  HANDOFF_NOTE_MAX_CHARS,
  HANDOFF_NOTE_MAX_TOKENS,
  HANDOFF_NOTE_TEMPLATE,
  HANDOFF_SECTIONS,
  type HandoffSection,
  handoffContentSchema,
  handoffHeading,
  handoffRejectionText,
  parseHandoffNote,
  validateHandoffNote,
} from './note';

const body: Record<HandoffSection, string> = {
  Goal: 'Ship the handoff contract.',
  Done: '- schema and migration',
  Next: '1. events\n2. command',
  'Decisions and why': '- events ride the events stream (#445 precedent)',
  'Dead ends': '- a new WebSocket message type: the protocol forbids it',
  'Files touched': '- packages/shared/src/handoff/note.ts',
  'How to verify': '- bun run --cwd packages/shared test',
  'Checklist status': '- [x] schema\n- [ ] docs',
  'Open questions': 'none',
};

const note = (
  sections: readonly HandoffSection[] = HANDOFF_SECTIONS,
  title = '# Handoff — C-12\n\n',
): string =>
  title + sections.map((s) => `${handoffHeading(s)}\n${body[s]}\n`).join('\n');

const codes = (content: string): string[] => {
  const v = validateHandoffNote(content);
  return v.ok ? [] : v.reasons.map((r) => r.code);
};

describe('validateHandoffNote (#449 D5)', () => {
  it('accepts every section, in order, with a title above', () => {
    const v = validateHandoffNote(note());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.sections.map((s) => s.section)).toEqual([...HANDOFF_SECTIONS]);
    expect(v.sections[2].body).toBe('1. events\n2. command');
  });

  it('matches headings case-insensitively', () => {
    expect(
      validateHandoffNote(note().replace('## Dead ends', '## dead ENDS')).ok,
    ).toBe(true);
  });

  it('allows empty sections but the Goal', () => {
    const empty = HANDOFF_NOTE_TEMPLATE;
    expect(codes(empty)).toEqual(['empty_goal']);
    expect(
      validateHandoffNote(empty.replace('## Goal\n', '## Goal\nShip it.\n')).ok,
    ).toBe(true);
  });

  it('rejects a missing section, naming it', () => {
    const v = validateHandoffNote(
      note(HANDOFF_SECTIONS.filter((s) => s !== 'Dead ends')),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reasons).toEqual([
      expect.objectContaining({
        code: 'missing_section',
        section: 'Dead ends',
      }),
    ]);
  });

  it('rejects an unknown, a duplicate and an out-of-order section', () => {
    expect(codes(`${note()}\n## Notes\nfoo\n`)).toEqual(['unknown_section']);
    expect(codes(`${note()}\n## Goal\nagain\n`)).toEqual(['duplicate_section']);
    const swapped = [...HANDOFF_SECTIONS];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(codes(note(swapped))).toEqual(['out_of_order']);
  });

  it('ignores headings inside a code fence', () => {
    const fenced = note().replace(
      '- bun run --cwd packages/shared test',
      '```md\n## Not a section\n```',
    );
    expect(validateHandoffNote(fenced).ok).toBe(true);
  });

  it('rejects a note over ~3k tokens, at exactly the char cap', () => {
    const base = note();
    const padTo = (chars: number) =>
      base.replace('none', `none ${'x'.repeat(chars - base.length - 1)}`);
    expect(padTo(HANDOFF_NOTE_MAX_CHARS).length).toBe(HANDOFF_NOTE_MAX_CHARS);
    expect(validateHandoffNote(padTo(HANDOFF_NOTE_MAX_CHARS)).ok).toBe(true);
    expect(codes(padTo(HANDOFF_NOTE_MAX_CHARS + 1))).toEqual(['too_large']);
    expect(estimateHandoffTokens(padTo(HANDOFF_NOTE_MAX_CHARS + 1))).toBe(
      HANDOFF_NOTE_MAX_TOKENS + 1,
    );
  });

  it('returns every reason at once', () => {
    expect(codes('## Goal\n\n## Notes\n').sort()).toEqual(
      [
        'empty_goal',
        'unknown_section',
        ...Array(HANDOFF_SECTIONS.length - 1).fill('missing_section'),
      ].sort(),
    );
  });
});

describe('handoffRejectionText', () => {
  it('lists each reason for the agent', () => {
    const v = validateHandoffNote('## Goal\n');
    if (v.ok) throw new Error('expected a rejection');
    const text = handoffRejectionText(v.reasons);
    expect(text).toStartWith('The handoff note was not accepted.');
    expect(text).toContain('"## Dead ends" is missing');
    expect(text.split('\n')).toHaveLength(v.reasons.length + 1);
  });
});

describe('parseHandoffNote / handoffContentSchema', () => {
  it('parses a valid note and refuses an invalid one', () => {
    expect(parseHandoffNote(note())).toHaveLength(HANDOFF_SECTIONS.length);
    expect(parseHandoffNote('## Goal\nx\n')).toBeNull();
    expect(handoffContentSchema.safeParse(note()).success).toBe(true);
    const bad = handoffContentSchema.safeParse('## Goal\nx\n');
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.length).toBe(HANDOFF_SECTIONS.length - 1);
  });
});
