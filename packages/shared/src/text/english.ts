import { maskText, TEXT_PLACEHOLDER_PATTERN } from './mask';

/**
 * D5 (issue #271): a text that is already English is skipped with no model
 * call. The check runs on the masked text (D6), so code, paths and
 * identifiers count for nothing:
 * - fewer than `ENGLISH_MIN_LETTERS` letters left → skip (nothing to translate);
 * - any letter outside ASCII → the model;
 * - fewer than `ENGLISH_SHORT_WORDS` words → skip (a short ASCII label);
 * - at least `ENGLISH_FUNCTION_WORD_SHARE` of the words in
 *   `ENGLISH_FUNCTION_WORDS` → skip;
 * - anything else → the model, which may still answer `alreadyEnglish`.
 *
 * Latin-script text in another language with no diacritics and no English
 * function words goes to the model, which is the safe side. [Assumption:
 * these thresholds.]
 */

export const ENGLISH_MIN_LETTERS = 3;
export const ENGLISH_SHORT_WORDS = 4;
export const ENGLISH_FUNCTION_WORD_SHARE = 0.15;

/** 150 common English function words, lower case. */
export const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'done',
  'down',
  'during',
  'each',
  'either',
  'else',
  'enough',
  'even',
  'ever',
  'every',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'however',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'least',
  'less',
  'let',
  'may',
  'me',
  'might',
  'more',
  'most',
  'much',
  'must',
  'my',
  'neither',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'onto',
  'or',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'own',
  'same',
  'shall',
  'she',
  'should',
  'since',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'though',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'upon',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'whether',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'within',
  'without',
  'would',
  'yet',
  'you',
  'your',
  'yours',
  'via',
  'per',
  'unless',
  'already',
]);

const LETTER = /\p{L}/gu;
const NON_ASCII_LETTER = /[^\p{ASCII}]/u;
const WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

/** Whether `text` may be stored as it is, with no model call (D5). */
export const isReliablyEnglish = (text: string): boolean => {
  const rest = maskText(text).masked.replace(TEXT_PLACEHOLDER_PATTERN, ' ');
  const letters = rest.match(LETTER) ?? [];
  if (letters.length < ENGLISH_MIN_LETTERS) return true;
  if (letters.some((letter) => NON_ASCII_LETTER.test(letter))) return false;
  const words = rest.match(WORD) ?? [];
  if (words.length < ENGLISH_SHORT_WORDS) return true;
  const functional = words.filter((word) =>
    ENGLISH_FUNCTION_WORDS.has(word.toLowerCase()),
  ).length;
  return functional / words.length >= ENGLISH_FUNCTION_WORD_SHARE;
};
