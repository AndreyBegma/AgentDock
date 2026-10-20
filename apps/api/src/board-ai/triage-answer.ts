import {
  BOARD_CARD_KINDS,
  type BoardCardKind,
  TRIAGE_PRIORITIES,
} from '@nautelle/shared';
import { z } from 'zod';

/** Duplicates one card shows, at most. */
export const TRIAGE_DUPLICATES_MAX = 3;

/** Characters of a reason kept. */
export const TRIAGE_REASON_MAX = 200;

const reason = z
  .string()
  .trim()
  .min(1)
  .transform((r) => r.slice(0, TRIAGE_REASON_MAX));

const answerSchema = z.object({
  duplicates: z
    .array(
      z
        .object({ number: z.number().int().positive(), reason })
        .nullable()
        .catch(null),
    )
    .catch([]),
  kind: z
    .object({ value: z.enum(BOARD_CARD_KINDS), reason })
    .nullable()
    .catch(null),
  priority: z
    .object({ value: z.enum(TRIAGE_PRIORITIES), reason })
    .nullable()
    .catch(null),
});

export interface TriageAnswer {
  duplicates: { number: number; reason: string }[];
  kind: { value: BoardCardKind; reason: string } | null;
  priority: { value: 'high' | 'low'; reason: string } | null;
}

/**
 * The model's triage as hints worth showing; null when the answer is not an
 * object. A duplicate must be one of the open cards it was shown; a kind the
 * card already has, and a `normal` priority, are no hint.
 */
export const parseTriageAnswer = (
  raw: unknown,
  card: { kind: BoardCardKind },
  shown: ReadonlySet<number>,
): TriageAnswer | null => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const answer = answerSchema.parse(raw);
  const seen = new Set<number>();
  const duplicates = answer.duplicates
    .filter((d): d is { number: number; reason: string } => d !== null)
    .filter(
      (d) => shown.has(d.number) && !seen.has(d.number) && seen.add(d.number),
    )
    .slice(0, TRIAGE_DUPLICATES_MAX);
  const kind =
    answer.kind && answer.kind.value !== card.kind ? answer.kind : null;
  const priority =
    answer.priority && answer.priority.value !== 'normal'
      ? { value: answer.priority.value, reason: answer.priority.reason }
      : null;
  return { duplicates, kind, priority };
};
