import {
  BOARD_ASK_CHECKS,
  BOARD_ASK_PR_STATES,
  BOARD_ASK_SOURCES,
  BOARD_CARD_KINDS,
  BOARD_COLUMNS,
  type BoardAskQuery,
} from '@agentdock/shared';
import { z } from 'zod';

/** Words of a query, at most; more only dilute it. */
export const ASK_TEXT_WORDS_MAX = 8;

/** The longest window a question may ask about. */
export const ASK_WITHIN_DAYS_MAX = 365;

/** Keeps the values of a list the model may write that are allowed; drops the rest. */
const listOf = <T extends string>(allowed: readonly T[]) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((values) =>
      values.filter((v): v is T => (allowed as readonly unknown[]).includes(v)),
    );

const oneOf = <T extends string>(allowed: readonly T[]) =>
  z
    .unknown()
    .optional()
    .transform((v): T | null =>
      (allowed as readonly unknown[]).includes(v) ? (v as T) : null,
    );

/**
 * #660: what the model writes for a question. Lenient by design — a field it
 * gets wrong narrows nothing rather than failing the question — but it never
 * lets through a value the search does not know.
 */
const askAnswerSchema = z.object({
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/)
    .catch('und'),
  projects: z
    .array(z.unknown())
    .catch([])
    .transform((values) =>
      values
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, 10),
    ),
  text: z
    .array(z.unknown())
    .catch([])
    .transform((values) =>
      values
        .filter((v): v is string => typeof v === 'string')
        .flatMap((v) => v.trim().split(/\s+/))
        .map((v) => v.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter((v) => v.length >= 2)
        .slice(0, ASK_TEXT_WORDS_MAX),
    ),
  columns: listOf(BOARD_COLUMNS),
  kind: oneOf(BOARD_CARD_KINDS),
  prState: oneOf(BOARD_ASK_PR_STATES),
  checks: oneOf(BOARD_ASK_CHECKS),
  withinDays: z
    .unknown()
    .optional()
    .transform((v) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 1
        ? Math.min(Math.round(v), ASK_WITHIN_DAYS_MAX)
        : null,
    ),
  sources: listOf(BOARD_ASK_SOURCES),
});

export interface ParsedAsk {
  language: string;
  query: BoardAskQuery;
}

/** The model's answer as a query; null when it is not an object at all. */
export const parseAskAnswer = (raw: unknown): ParsedAsk | null => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const parsed = askAnswerSchema.parse(raw);
  const { language, ...query } = parsed;
  return {
    language: language.split('-')[0] ?? 'und',
    query: {
      ...query,
      // No source named is every source.
      sources:
        query.sources.length > 0 ? query.sources : [...BOARD_ASK_SOURCES],
    },
  };
};

export interface NamedProject {
  id: string;
  displayName: string;
  repo: string;
}

const norm = (value: string) => value.trim().toLowerCase();

/**
 * The accessible projects a query names: by display name, `owner/name` or
 * repository name, case-insensitively. No names is every accessible project;
 * names that match none of them are nothing — a question never reaches a
 * project the person cannot access.
 */
export const projectsOfQuery = <P extends NamedProject>(
  names: readonly string[],
  accessible: readonly P[],
): P[] => {
  if (names.length === 0) return [...accessible];
  const wanted = new Set(names.map(norm));
  return accessible.filter((p) => {
    const repoName = p.repo.split('/').pop() ?? p.repo;
    return [p.displayName, p.repo, repoName].some((n) => wanted.has(norm(n)));
  });
};
