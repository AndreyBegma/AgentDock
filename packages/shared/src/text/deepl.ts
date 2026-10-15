import type { BoardCardKind } from '../board/types';
import {
  checkPlaceholders,
  TEXT_PLACEHOLDER_PATTERN,
  unmaskText,
} from './mask';
import type { MaskedTextField, ResolvedTextField } from './normalize-contract';

/**
 * DeepL translates stored text at save time (issue #324, ADR-0033). The API
 * sends each masked field (ADR-0027 §5) as XML, with every placeholder as an
 * `<x i="n"/>` tag DeepL is told to ignore, and reads the answer back through
 * the same checks a model's answer goes through.
 */

/** D1: the whole synchronous attempt inside a save. */
export const TEXT_DEEPL_TIMEOUT_MS = 4000;
/** D4, Q1. */
export const DEEPL_TARGET_LANG = 'EN-US';
/** D4: the tag a placeholder travels as. */
export const DEEPL_PLACEHOLDER_TAG = 'x';

/**
 * Why a DeepL call failed (D2):
 * - `quota` — `456`, the character quota is spent;
 * - `auth` — `403`, the key is rejected;
 * - `rate` — `429`;
 * - `unavailable` — a network error, `5xx`, or any other answer it cannot use;
 * - `timeout` — no answer within the budget.
 *
 * `quota` and `auth` go straight to the runner; the others are retried first.
 */
export const DEEPL_ERRORS = [
  'quota',
  'auth',
  'rate',
  'unavailable',
  'timeout',
] as const;
export type DeepLError = (typeof DEEPL_ERRORS)[number];

/** D2: no point asking DeepL again. */
export const isDeepLFinal = (error: DeepLError): boolean =>
  error === 'quota' || error === 'auth';

/** One translation as DeepL answers it, in the order the texts were sent. */
export interface DeepLAnswer {
  text: string;
  /** Upper case, e.g. `RU`, `EN`. */
  detectedSourceLanguage: string;
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ENTITY = /&(?:#(\d+)|#x([0-9A-Fa-f]+)|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const unescapeXml = (text: string): string =>
  text.replace(ENTITY, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name] ?? whole;
    const code = Number.parseInt(dec ?? hex ?? '', dec !== undefined ? 10 : 16);
    return Number.isSafeInteger(code) && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });

/** D5: a masked field as DeepL reads it. */
export const toDeepLXml = (masked: string): string =>
  escapeXml(masked).replace(
    TEXT_PLACEHOLDER_PATTERN,
    (_whole, n: string) => `<${DEEPL_PLACEHOLDER_TAG} i="${n}"/>`,
  );

/** `<x i="n"/>`, and the `<x i="n"></x>` form an XML writer may choose. */
const PLACEHOLDER_TAG = /<x\s+i\s*=\s*["'](\d+)["']\s*(?:\/>|>\s*<\/x\s*>)/g;

/**
 * D5: DeepL's answer back to a masked text — tags to placeholders, then the
 * text unescaped. `null` when markup other than a placeholder tag is left:
 * DeepL invented it, so the field is `rejected`.
 */
export const fromDeepLXml = (xml: string): string | null => {
  const masked = xml.replace(PLACEHOLDER_TAG, (_whole, n: string) => `⟦${n}⟧`);
  if (/[<>]/.test(masked)) return null;
  return unescapeXml(masked);
};

/**
 * D5, D6: one result per field sent, in order. DeepL saying the source was
 * English, or answering the text unchanged, is `already_english`; a lost,
 * repeated or invented tag is `rejected`.
 */
export const resolveDeepLFields = (
  fields: readonly MaskedTextField[],
  answers: readonly DeepLAnswer[],
): ResolvedTextField[] =>
  fields.map((field, index): ResolvedTextField => {
    const answer = answers[index];
    if (answer === undefined) return { id: field.id, outcome: 'rejected' };
    if (answer.detectedSourceLanguage.toUpperCase().startsWith('EN')) {
      return { id: field.id, outcome: 'already_english' };
    }
    const masked = fromDeepLXml(answer.text);
    if (masked === null || !checkPlaceholders(masked, field.spans.length)) {
      return { id: field.id, outcome: 'rejected' };
    }
    const english = unmaskText(masked, field.spans);
    if (english === field.original) {
      return { id: field.id, outcome: 'already_english' };
    }
    if (english.trim() === '') return { id: field.id, outcome: 'rejected' };
    return { id: field.id, outcome: 'translated', english };
  });

// D7 — kind without a model.

/** How much of the body the kind rule reads. */
export const CARD_KIND_BODY_CHARS = 500;

/** A card reporting one of these is a `bug`. */
export const CARD_KIND_BUG_WORDS = [
  'bug',
  'fix',
  'broken',
  'crash',
  'error',
  'fails',
  'failing',
  "doesn't work",
  'does not work',
  'regression',
  'exception',
  'wrong',
  '500',
  '404',
] as const;

const BUG_WORDS = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${CARD_KIND_BUG_WORDS.map((word) =>
    word.replace(/'/g, "['’]").replace(/ /g, '\\s+'),
  ).join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
);

/**
 * D7: the kind of an English card — `bug` when its title or the start of its
 * body uses a word of `CARD_KIND_BUG_WORDS`, else `feature`.
 */
export const classifyCardKindEnglish = (
  title: string,
  body: string,
): BoardCardKind =>
  BUG_WORDS.test(title) || BUG_WORDS.test(body.slice(0, CARD_KIND_BODY_CHARS))
    ? 'bug'
    : 'feature';
