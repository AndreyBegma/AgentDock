import { describe, expect, it } from 'bun:test';
import {
  REGISTER_FULL_PROSE_EXEMPTIONS,
  TERSE_REGISTER,
  TERSE_REGISTER_LINES,
} from './register';

describe('terse register (#663 D2, D3)', () => {
  it('is the lines joined, so the printed text and the prompt agree', () => {
    expect(TERSE_REGISTER).toBe(TERSE_REGISTER_LINES.join('\n'));
  });

  it('names every exemption that stays in full prose', () => {
    for (const exemption of REGISTER_FULL_PROSE_EXEMPTIONS) {
      expect(TERSE_REGISTER).toContain(exemption);
    }
    for (const word of ['PR descriptions', 'commits', 'code comments']) {
      expect(TERSE_REGISTER).toContain(word);
    }
    expect(TERSE_REGISTER).toContain('questions to the person');
    expect(TERSE_REGISTER).toContain('`finish_card` summaries');
  });

  it('is terse about the terminal and says so', () => {
    expect(TERSE_REGISTER).toContain('caveman');
    expect(TERSE_REGISTER).toContain('no preamble');
  });
});
