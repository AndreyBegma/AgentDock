import { z } from 'zod';
import {
  CARD_ASSESS_REASON_MAX,
  CARD_DESIGN_RECOMMENDABLE_MODELS,
  CARD_RECOMMENDABLE_MODELS,
} from './limits';

/**
 * The answer contract of `card.assess` (issue #322 D6). The model answers with
 * strict JSON:
 *
 * ```json
 * {"work": {"model": "sonnet", "reason": "Executes a clear, single-module change."},
 *  "design": {"model": "opus", "reason": "The layout is still undecided."}}
 * ```
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
