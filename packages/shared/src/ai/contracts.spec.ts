import { describe, expect, it } from 'bun:test';
import {
  aiDigestSentTitle,
  aiDigestSkippedTitle,
  aiReaderLanguage,
  isTimeZone,
} from './contracts';

describe('aiReaderLanguage', () => {
  it('takes the primary subtag of a locale', () => {
    expect(aiReaderLanguage('ru-RU')).toBe('ru');
    expect(aiReaderLanguage('uk')).toBe('uk');
    expect(aiReaderLanguage('EN_gb')).toBe('en');
  });

  it('falls back to English', () => {
    expect(aiReaderLanguage(undefined)).toBe('en');
    expect(aiReaderLanguage('')).toBe('en');
    expect(aiReaderLanguage('x-klingon')).toBe('en');
  });
});

describe('isTimeZone', () => {
  it('knows IANA zones and nothing else', () => {
    expect(isTimeZone('Europe/Kyiv')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Base')).toBe(false);
    expect(isTimeZone(' ')).toBe(false);
  });
});

describe('digest activity titles', () => {
  it('counts the sections of a sent digest', () => {
    expect(aiDigestSentTitle({ done: 3, stuck: 1, waiting: 2 })).toBe(
      'Daily digest: 3 done, 1 stuck, 2 waiting',
    );
  });

  it('says why a digest was skipped', () => {
    expect(aiDigestSkippedTitle('llm_cap_reached')).toContain('monthly cap');
    expect(aiDigestSkippedTitle('no_model')).toContain('no default AI model');
    expect(aiDigestSkippedTitle(null)).toContain('refused');
  });
});
