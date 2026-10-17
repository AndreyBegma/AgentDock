import { describe, expect, it } from 'bun:test';
import { llmMonthStart, llmNextReset } from './period';
import { llmKeySuffix } from './providers';

describe('the UTC cap month', () => {
  it('starts at 00:00 UTC on the 1st', () => {
    expect(llmMonthStart(new Date('2026-10-17T13:00:00+05:00')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('resets at 00:00 UTC on the 1st of the next month, across a year', () => {
    expect(llmNextReset(new Date('2026-10-31T23:59:59.999Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(llmNextReset(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('puts the reset instant itself in the new month', () => {
    const reset = new Date('2026-11-01T00:00:00.000Z');
    expect(llmMonthStart(reset).getTime()).toBe(reset.getTime());
  });
});

describe('llmKeySuffix', () => {
  it('keeps the last four characters only', () => {
    expect(llmKeySuffix('sk-ant-api03-abcdef4f2a')).toBe('4f2a');
  });

  it('masks nothing of a key too short to hide', () => {
    expect(llmKeySuffix('short')).toBeNull();
  });
});
