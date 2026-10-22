import { z } from 'zod';
import {
  CARD_ASSESS_REASON_MAX,
  CARD_DECIDING_SIGNALS,
  CARD_DESIGN_RECOMMENDABLE_MODELS,
  CARD_EFFORTS,
  CARD_RECOMMENDABLE_MODELS,
  CARD_WORK_CLASSES,
} from './limits';

/**
 * The answer contract of `card.assess` (issue #322 D6). The model answers with
 * strict JSON:
 *
 * ```json
 * {"work": {"model": "sonnet", "effort": "low", "class": "mechanical", "signals": [],
 *           "reason": "Executes a clear, single-module change."},
 *  "design": {"model": "opus", "reason": "The layout is still undecided."}}
 * ```
 *
 * #750: `class` and `signals` are required — an answer without them is out of
 * contract and the card counts as `unsure` (D1).
 *
 * Anything else — another shape, an extra key, a model outside the lists, a
 * blank or overlong reason — is out of contract: nothing is stored and the
 * `runs` row ends `failed` (D7). Getting the JSON out of the CLI's text is the
 * API's parser; this is the shape it must have.
 */

const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(CARD_ASSESS_REASON_MAX)
  .refine((r) => !/[\r\n]/.test(r), { message: 'must be one line' });

export const cardAssessWorkAnswerSchema = z.strictObject({
  model: z.enum(CARD_RECOMMENDABLE_MODELS),
  /** #663 (ADR-0068 §5): the effort the work runs at, next to its model. */
  effort: z.enum(CARD_EFFORTS),
  /** #750 D1: the class the model gave; `effectiveWorkClass` applies D2. */
  class: z.enum(CARD_WORK_CLASSES),
  /** #750 D2: the deciding signals found, each at most once. */
  signals: z
    .array(z.enum(CARD_DECIDING_SIGNALS))
    .max(CARD_DECIDING_SIGNALS.length)
    .refine((s) => new Set(s).size === s.length, {
      message: 'signals must be distinct',
    }),
  reason: reasonSchema,
});

export const cardAssessDesignAnswerSchema = z.strictObject({
  model: z.enum(CARD_DESIGN_RECOMMENDABLE_MODELS),
  reason: reasonSchema,
});

export const cardAssessAnswerSchema = z.strictObject({
  work: cardAssessWorkAnswerSchema,
  design: cardAssessDesignAnswerSchema,
});
export type CardAssessAnswer = z.infer<typeof cardAssessAnswerSchema>;
