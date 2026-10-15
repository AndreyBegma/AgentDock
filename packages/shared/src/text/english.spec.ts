import { describe, expect, it } from 'bun:test';
import { ENGLISH_FUNCTION_WORDS, isReliablyEnglish } from './english';

describe('isReliablyEnglish', () => {
  it('holds exactly 150 lower-case function words', () => {
    expect(ENGLISH_FUNCTION_WORDS.size).toBe(150);
    for (const word of ENGLISH_FUNCTION_WORDS) {
      expect(word).toBe(word.toLowerCase());
    }
  });

  it('skips plain English', () => {
    expect(
      isReliablyEnglish(
        'The login button does nothing when the session has expired.',
      ),
    ).toBe(true);
    expect(
      isReliablyEnglish(
        'Add a retry to the upload so that a flaky network is not fatal',
      ),
    ).toBe(true);
  });

  it('skips short ASCII labels', () => {
    expect(isReliablyEnglish('Fix login')).toBe(true);
    expect(isReliablyEnglish('Dark mode toggle')).toBe(true);
  });

  it('skips text with almost no letters', () => {
    expect(isReliablyEnglish('')).toBe(true);
    expect(isReliablyEnglish('42 / 7 ok')).toBe(true);
    expect(isReliablyEnglish('`Кнопка` да')).toBe(true);
  });

  it('does not count masked code', () => {
    expect(
      isReliablyEnglish('Check `пример()` in src/app/page.tsx, please'),
    ).toBe(true);
    expect(
      isReliablyEnglish('```\n// комментарий\n```\nThe snippet above fails'),
    ).toBe(true);
  });

  it('does not skip Cyrillic', () => {
    expect(isReliablyEnglish('Кнопка входа не работает')).toBe(false);
    expect(isReliablyEnglish('Додати темну тему')).toBe(false);
  });

  it('does not skip mixed text', () => {
    expect(isReliablyEnglish('Fix the кнопку on the login page')).toBe(false);
    expect(isReliablyEnglish('Почини userId в login flow')).toBe(false);
  });

  it('does not skip Latin text with diacritics', () => {
    expect(isReliablyEnglish('Ajouter un bouton à la page')).toBe(false);
    expect(isReliablyEnglish('Napraw przycisk logowania żeby działał')).toBe(
      false,
    );
  });

  it('sends Latin text without English function words to the model', () => {
    expect(isReliablyEnglish('Napraw przycisk logowania na stronie')).toBe(
      false,
    );
  });
});
