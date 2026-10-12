import {
  type SkillFrontmatter,
  skillFrontmatterSchema,
} from '@agentdock/shared/protocol';
import { YAML } from 'bun';

/** The frontmatter block is read from at most this much of `SKILL.md`. */
const MAX_FRONTMATTER_BYTES = 16 * 1024;

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const KEYS = [
  'name',
  'description',
  'allowed-tools',
  'argument-hint',
  'user-invocable',
  'disable-model-invocation',
] as const;

/**
 * The D2 keys of a `SKILL.md` frontmatter, each kept only when it fits its
 * bounded schema; anything else — other keys, an unparsable block, a value of
 * the wrong type — is left out rather than guessed.
 */
export const parseFrontmatter = (text: string): SkillFrontmatter => {
  const match = FRONTMATTER.exec(text.slice(0, MAX_FRONTMATTER_BYTES));
  if (!match) return {};
  let raw: unknown;
  try {
    raw = YAML.parse(match[1] ?? '');
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of KEYS) {
    if (!(key in source)) continue;
    const field = skillFrontmatterSchema.shape[key].safeParse(source[key]);
    if (field.success && field.data !== undefined) result[key] = field.data;
  }
  return skillFrontmatterSchema.parse(result);
};
