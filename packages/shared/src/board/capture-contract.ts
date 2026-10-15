import { z } from 'zod';
import {
  captureFingerprint,
  normalizeCaptureTitle,
} from './capture-fingerprint';
import {
  CAPTURE_BODY_MAX,
  CAPTURE_EVIDENCE_MAX,
  CAPTURE_EVIDENCE_MIN,
  CAPTURE_MAX_CARDS,
  CAPTURE_MIN_CONFIDENCE,
  CAPTURE_TITLE_MAX,
  CAPTURE_WHY_MAX,
} from './capture-limits';
import { BOARD_CARD_KINDS, type BoardCardKind } from './types';

/**
 * D5 (issue #244): the output contract of an extraction. The model answers
 * with exactly one fenced block whose info string is `agentdock-cards`:
 *
 * ```agentdock-cards
 * {"cards": [{"title": "…", "body": "…", "kind": "feature", "why": "…",
 *             "confidence": 0.8, "evidence": [123, 130]}]}
 * ```
 *
 * Anything else — no block, two blocks, bad JSON, a field out of range, more
 * than `CAPTURE_MAX_CARDS` cards, an evidence id that was not in the input —
 * is a `contract_violation`, and nothing is applied. The runner does not
 * parse; the API does, with `parseCaptureOutput`.
 */

export const CAPTURE_FENCE_INFO = 'agentdock-cards';

/** Why an output broke the contract (`card_captures.error`). */
export const CAPTURE_VIOLATIONS = [
  'no_block',
  'multiple_blocks',
  'unterminated_block',
  'invalid_json',
  'too_many_cards',
  'invalid_card',
  'unknown_evidence',
] as const;
export type CaptureViolation = (typeof CAPTURE_VIOLATIONS)[number];

const oneLine = (t: string): boolean => !/[\r\n]/.test(t);

/**
 * A content id as the model writes it: the number from the prompt's
 * `id="…"`, or the same digits as a string. Normalized to a decimal string,
 * as `session_contents.id` (a BigInt) is everywhere outside the database.
 */
const evidenceIdSchema = z
  .union([
    z.number().int().positive().refine(Number.isSafeInteger),
    z.string().regex(/^[1-9][0-9]{0,18}$/),
  ])
  .transform((id) => String(id));

export const captureCardSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(CAPTURE_TITLE_MAX)
    .refine(oneLine, { message: 'must be one line' })
    .refine((t) => normalizeCaptureTitle(t) !== '', {
      message: 'must contain a word',
    }),
  body: z.string().max(CAPTURE_BODY_MAX).default(''),
  kind: z.enum(BOARD_CARD_KINDS),
  why: z.string().trim().min(1).max(CAPTURE_WHY_MAX),
  confidence: z.number().min(0).max(1),
  evidence: z
    .array(evidenceIdSchema)
    .min(CAPTURE_EVIDENCE_MIN)
    .max(CAPTURE_EVIDENCE_MAX)
    .transform((ids) => [...new Set(ids)]),
});

export const captureOutputSchema = z.strictObject({
  cards: z.array(captureCardSchema).max(CAPTURE_MAX_CARDS),
});

/** One candidate card, as the model proposed it. */
export interface CaptureSuggestion {
  title: string;
  body: string;
  kind: BoardCardKind;
  why: string;
  confidence: number;
  /** `session_contents.id`s, decimal strings, distinct. */
  evidence: string[];
}

export type CaptureParseResult =
  | { ok: true; cards: CaptureSuggestion[] }
  | {
      ok: false;
      error: 'contract_violation';
      reason: CaptureViolation;
      /** For `card_captures.error`; never contains content. */
      message: string;
    };

/** `card_captures.error` of a `failed` row whose output broke the contract. */
export const captureViolationError = (
  result: Extract<CaptureParseResult, { ok: false }>,
): string => `${result.error}: ${result.reason} — ${result.message}`;

const violation = (
  reason: CaptureViolation,
  message: string,
): CaptureParseResult => ({
  ok: false,
  error: 'contract_violation',
  reason,
  message,
});

const OPEN_FENCE = new RegExp(`^\`\`\`${CAPTURE_FENCE_INFO}[ \\t]*$`, 'gm');
const CLOSE_FENCE = /^```[ \t]*$/m;

/**
 * Checks `text` (the model's final result) against the contract.
 * `inputIds` are the content ids that went into the prompt; every evidence id
 * must be one of them.
 */
export const parseCaptureOutput = (
  text: string,
  inputIds: Iterable<string | number | bigint>,
): CaptureParseResult => {
  const opens = [...text.matchAll(OPEN_FENCE)];
  if (opens.length === 0) {
    return violation('no_block', `no ${CAPTURE_FENCE_INFO} block`);
  }
  if (opens.length > 1) {
    return violation(
      'multiple_blocks',
      `${opens.length} ${CAPTURE_FENCE_INFO} blocks, expected one`,
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
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'cards' in raw &&
    Array.isArray(raw.cards) &&
    raw.cards.length > CAPTURE_MAX_CARDS
  ) {
    return violation(
      'too_many_cards',
      `${raw.cards.length} cards, at most ${CAPTURE_MAX_CARDS}`,
    );
  }
  const parsed = captureOutputSchema.safeParse(raw);
  if (!parsed.success) {
    // The issue paths only: a message may quote the offending value.
    const where = parsed.error.issues
      .map((issue) => issue.path.join('.') || '(root)')
      .join(', ');
    return violation('invalid_card', `invalid fields: ${where}`);
  }

  const allowed = new Set(Array.from(inputIds, (id) => String(id)));
  for (const [index, card] of parsed.data.cards.entries()) {
    const unknown = card.evidence.filter((id) => !allowed.has(id));
    if (unknown.length > 0) {
      return violation(
        'unknown_evidence',
        `cards.${index}.evidence: ${unknown.join(', ')} not in the input`,
      );
    }
  }
  return { ok: true, cards: parsed.data.cards };
};

/** Why `selectCaptureCards` dropped a suggestion (D6). */
export type CaptureDropReason =
  /** Below `CAPTURE_MIN_CONFIDENCE`. */
  | 'low_confidence'
  /** Another suggestion of the same result has the fingerprint. */
  | 'duplicate'
  /** An open card, a recently completed card or a recent dismissal has it. */
  | 'known';

export interface FingerprintedSuggestion extends CaptureSuggestion {
  fingerprint: string;
}

export interface CaptureSelection {
  /** In the model's order. */
  kept: FingerprintedSuggestion[];
  dropped: { fingerprint: string; reason: CaptureDropReason }[];
}

/**
 * The pure part of D6: drops low-confidence suggestions, collapses the
 * duplicates of one result (the most confident wins, the first on a tie) and
 * drops every fingerprint in `known`. The caller builds `known` from the
 * project's non-completed cards, cards completed within
 * `CAPTURE_COMPLETED_DEDUPE_DAYS` and dismissals within
 * `CAPTURE_DISMISSAL_DEDUPE_DAYS`.
 */
export const selectCaptureCards = (
  cards: readonly CaptureSuggestion[],
  known: ReadonlySet<string>,
): CaptureSelection => {
  const dropped: CaptureSelection['dropped'] = [];
  const best = new Map<string, FingerprintedSuggestion>();
  for (const card of cards) {
    const fingerprint = captureFingerprint(card.title);
    if (card.confidence < CAPTURE_MIN_CONFIDENCE) {
      dropped.push({ fingerprint, reason: 'low_confidence' });
      continue;
    }
    if (known.has(fingerprint)) {
      dropped.push({ fingerprint, reason: 'known' });
      continue;
    }
    const seen = best.get(fingerprint);
    if (seen === undefined) {
      best.set(fingerprint, { ...card, fingerprint });
      continue;
    }
    dropped.push({ fingerprint, reason: 'duplicate' });
    if (card.confidence > seen.confidence) {
      best.set(fingerprint, { ...card, fingerprint });
    }
  }
  const kept = cards
    .map((card) => best.get(captureFingerprint(card.title)))
    .filter(
      (card, index, all): card is FingerprintedSuggestion =>
        card !== undefined && all.indexOf(card) === index,
    );
  return { kept, dropped };
};
