import { z } from 'zod';
import { BOARD_CARD_KINDS } from '../board/types';
import { checkPlaceholders, unmaskText } from './mask';

/**
 * The output contract of `text.normalize` (issue #271 "Runner", D6). The
 * model answers with exactly one fenced block whose info string is
 * `agentdock-text`:
 *
 * ```agentdock-text
 * {"fields": [{"id": "title", "english": "Fix the ⟦1⟧ button", "alreadyEnglish": false}],
 *  "kind": "bug"}
 * ```
 *
 * A structural break — no block, two blocks, bad JSON, a wrong shape, a
 * missing, unknown or repeated id, `kind` present when not asked or absent
 * when asked — is a `contract_violation`, and nothing is applied.
 *
 * A lost, repeated or invented placeholder is not: it is a defect in one
 * field's text, so that field is `rejected` and keeps its original while the
 * other fields apply (D6, as the orchestrator ruled on 2026-10-15; acceptance
 * #2 and the Runner section of the issue are read through D6).
 */

export const TEXT_FENCE_INFO = 'agentdock-text';

export const TEXT_VIOLATIONS = [
  'no_block',
  'multiple_blocks',
  'unterminated_block',
  'invalid_json',
  'invalid_shape',
  'missing_field',
  'unknown_field',
  'duplicate_field',
  'unexpected_kind',
  'missing_kind',
] as const;
export type TextViolation = (typeof TEXT_VIOLATIONS)[number];

export const textOutputFieldSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    english: z.string().optional(),
    alreadyEnglish: z.boolean(),
  })
  .refine((f) => f.alreadyEnglish || (f.english ?? '').trim() !== '', {
    message: 'a translated field carries english',
    path: ['english'],
  });

export const textOutputSchema = z.strictObject({
  fields: z.array(textOutputFieldSchema),
  kind: z.enum(BOARD_CARD_KINDS).optional(),
});
export type TextOutput = z.infer<typeof textOutputSchema>;

/** What a request asked: its field ids, and whether it asked for `kind`. */
export interface TextOutputExpectation {
  ids: readonly string[];
  classifyKind: boolean;
}

export type TextParseResult =
  | { ok: true; output: TextOutput }
  | {
      ok: false;
      error: 'contract_violation';
      reason: TextViolation;
      /** For `text_normalizations.error`; never contains the text. */
      message: string;
    };

/** `text_normalizations.error` of a request whose output broke the contract. */
export const textViolationError = (
  result: Extract<TextParseResult, { ok: false }>,
): string => `${result.error}: ${result.reason} — ${result.message}`;

const violation = (
  reason: TextViolation,
  message: string,
): TextParseResult => ({
  ok: false,
  error: 'contract_violation',
  reason,
  message,
});

const OPEN_FENCE = new RegExp(`^\`\`\`${TEXT_FENCE_INFO}[ \\t]*$`, 'gm');
const CLOSE_FENCE = /^```[ \t]*$/m;

/** Checks `text` (the model's final result) against the contract's structure. */
export const parseNormalizeOutput = (
  text: string,
  expected: TextOutputExpectation,
): TextParseResult => {
  const opens = [...text.matchAll(OPEN_FENCE)];
  if (opens.length === 0) {
    return violation('no_block', `no ${TEXT_FENCE_INFO} block`);
  }
  if (opens.length > 1) {
    return violation(
      'multiple_blocks',
      `${opens.length} ${TEXT_FENCE_INFO} blocks, expected one`,
    );
  }
  const open = opens[0];
  const rest = text.slice((open.index ?? 0) + open[0].length);
  const close = CLOSE_FENCE.exec(rest);
  if (close === null) {
    return violation('unterminated_block', 'the block is not closed');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rest.slice(0, close.index));
  } catch {
    return violation('invalid_json', 'the block is not valid JSON');
  }
  const parsed = textOutputSchema.safeParse(raw);
  if (!parsed.success) {
    // The issue paths only: a message may quote the offending value.
    const where = parsed.error.issues
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ');
    return violation('invalid_shape', `invalid fields: ${where}`);
  }

  const asked = new Set(expected.ids);
  const seen = new Set<string>();
  for (const field of parsed.data.fields) {
    if (!asked.has(field.id)) {
      return violation('unknown_field', `${field.id} was not asked`);
    }
    if (seen.has(field.id)) {
      return violation('duplicate_field', `${field.id} answered twice`);
    }
    seen.add(field.id);
  }
  const missing = expected.ids.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return violation('missing_field', `${missing.join(', ')} not answered`);
  }
  if (expected.classifyKind && parsed.data.kind === undefined) {
    return violation('missing_kind', 'kind was asked and not answered');
  }
  if (!expected.classifyKind && parsed.data.kind !== undefined) {
    return violation('unexpected_kind', 'kind was not asked');
  }
  return { ok: true, output: parsed.data };
};

/** A field as it went into the prompt (`prepareTextFields`). */
export interface MaskedTextField {
  id: string;
  /** The typed text. */
  original: string;
  /** The text with code masked (D6). */
  masked: string;
  /** What each placeholder stands for. */
  spans: string[];
}

/** One field's result before the compare-and-set of D8. */
export type ResolvedTextField =
  | { id: string; outcome: 'translated'; english: string }
  | { id: string; outcome: 'already_english' | 'rejected' };

/**
 * Turns a parsed output into one result per asked field, in the order of
 * `fields`: placeholders are checked and restored (D6), and a field the model
 * called English, or returned unchanged, is `already_english`.
 */
export const resolveNormalizedFields = (
  fields: readonly MaskedTextField[],
  output: TextOutput,
): ResolvedTextField[] => {
  const answers = new Map(output.fields.map((f) => [f.id, f]));
  return fields.map((field): ResolvedTextField => {
    const answer = answers.get(field.id);
    if (answer === undefined || answer.alreadyEnglish) {
      return { id: field.id, outcome: 'already_english' };
    }
    const english = answer.english ?? '';
    if (!checkPlaceholders(english, field.spans.length)) {
      return { id: field.id, outcome: 'rejected' };
    }
    const restored = unmaskText(english, field.spans);
    if (restored === field.original) {
      return { id: field.id, outcome: 'already_english' };
    }
    return { id: field.id, outcome: 'translated', english: restored };
  });
};
