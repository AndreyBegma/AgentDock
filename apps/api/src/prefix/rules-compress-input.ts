import {
  type CompressedRules,
  compressedRulesSchema,
  projectRulesBlock,
} from '@nautelle/shared';
import { z } from 'zod';

/** One enabled rule, as the compression sees it. */
export interface CompressRuleInput {
  id: string;
  title: string;
  description: string;
}

/**
 * B6: the `rules.compress` prompt — every enabled rule with its id, and the
 * one answer shape the API accepts. Built from the database (ADR-0001).
 */
export const buildCompressPrompt = (
  rules: readonly CompressRuleInput[],
): string =>
  [
    'You compress the coding rules a coding agent reads at the start of every session.',
    'For each rule, rewrite its description as short as it can be without losing any requirement, condition, name, path, command or number. Drop repetition, filler and examples the rule does not need. Never merge, drop or add a rule; keep each title as it is.',
    'Answer with JSON only, no code fence: {"rules":[{"id":"<id>","description":"<compressed>"}]} — one entry per rule, every id exactly once.',
    '',
    'The rules:',
    JSON.stringify(
      rules.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
      })),
    ),
  ].join('\n');

const answerSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().max(4000),
    }),
  ),
});

export type CompressParse =
  | { ok: true; compressed: CompressedRules }
  | { ok: false; message: string };

/** Strips one surrounding code fence, which models add despite being told not to. */
const unfence = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*)\n```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
};

/**
 * B6: the answer, checked against the rules it was asked about — every id
 * exactly once and no other. A description is never longer than the
 * original; a longer one keeps the original.
 */
export const parseCompressAnswer = (
  text: string,
  rules: readonly CompressRuleInput[],
): CompressParse => {
  let json: unknown;
  try {
    json = JSON.parse(unfence(text));
  } catch {
    return { ok: false, message: 'the answer is not JSON' };
  }
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, message: 'the answer is not {"rules":[…]}' };
  }
  const byId = new Map(parsed.data.rules.map((r) => [r.id, r.description]));
  if (
    byId.size !== parsed.data.rules.length ||
    byId.size !== rules.length ||
    rules.some((r) => !byId.has(r.id))
  ) {
    return { ok: false, message: 'the answer does not name every rule once' };
  }
  const compressed = compressedRulesSchema.safeParse({
    rules: rules.map((r) => {
      const description = (byId.get(r.id) ?? '').trim();
      return {
        id: r.id,
        title: r.title,
        description:
          description.length > 0 && description.length <= r.description.length
            ? description
            : r.description,
      };
    }),
  });
  return compressed.success
    ? { ok: true, compressed: compressed.data }
    : { ok: false, message: 'a compressed rule is malformed' };
};

/** The rendered rules block, the text the diff and the sizes are about. */
export const renderedRules = (rules: readonly CompressRuleInput[]): string =>
  projectRulesBlock(rules.map((r) => ({ ...r, enabled: true }))).text ?? '';
