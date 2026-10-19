import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { orchestratorModelSchema } from './control';
import { profileKeySchema, skillRunIdSchema } from './skills';

/**
 * Code commands for the assistant (#622, ADR-0063). The API never reads a
 * project's files (ADR-0001): it asks the project's runner, which reads its
 * own checkout. All three are read-only.
 *
 * - `repo.search` and `repo.read` return bounded text from files git knows
 *   in the checkout (tracked, or untracked and not ignored).
 * - `code.ask` runs one read-only Claude Code session in the checkout and
 *   returns its answer.
 *
 * Every path is checked on the runner: it must resolve inside the checkout,
 * through no symlink that leaves it, and it must not be a secret
 * (`.env*`, key files) or a path the runner-local policy denies
 * (`code.deny`, ADR-0047). The schemas here only bound the strings.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** At most this many matches a search returns. */
export const REPO_SEARCH_RESULTS_MAX = 100;
export const REPO_SEARCH_RESULTS_DEFAULT = 40;
/** A match line is cut to this many characters. */
export const REPO_SEARCH_LINE_MAX = 300;
/** At most this many lines one read returns. */
export const REPO_READ_LINES_MAX = 400;
/** At most this many characters one read returns, whatever the line count. */
export const REPO_READ_CHARS_MAX = 24_000;
/** A file larger than this is never read. */
export const REPO_READ_FILE_BYTES_MAX = 2 * 1024 * 1024;
/** The question a code agent is asked. */
export const CODE_ASK_QUESTION_MAX = 4_000;
/** The answer is cut to this many characters. */
export const CODE_ASK_ANSWER_MAX = 12_000;
/** The model `code.ask` runs unless the API names another. */
export const CODE_ASK_DEFAULT_MODEL = 'sonnet';
/** The runner gives the session up after this long. */
export const CODE_ASK_TIMEOUT_SEC = 240;

export const REPO_TIMEOUTS_MS = {
  search: 20_000,
  read: 15_000,
  /** The session, plus the start of `claude`. */
  ask: (CODE_ASK_TIMEOUT_SEC + 20) * 1000,
} as const;

/**
 * A path relative to the checkout, as the model wrote it. Only its length
 * and characters are checked here; whether it stays inside the checkout is
 * the runner's check, so a `..` reaches it and is refused there.
 */
export const repoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((p) => !CONTROL_CHARS.test(p), {
    message: 'must not contain control characters',
  });

const repoTarget = {
  projectId: z.string().min(1),
  /** The project's main checkout, checked against the watch list. */
  root: absolutePathSchema,
};

// repo.search

/**
 * A text search over the checkout (`git grep`): a fixed string unless
 * `regex`, case-insensitive unless `caseSensitive`. `path` narrows it to a
 * directory or a file. Denied files are left out of the result.
 */
export const repoSearchArgsSchema = z.strictObject({
  ...repoTarget,
  query: z
    .string()
    .min(1)
    .max(200)
    .refine((q) => !CONTROL_CHARS.test(q), {
      message: 'must not contain control characters',
    }),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  path: repoPathSchema.optional(),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(REPO_SEARCH_RESULTS_MAX)
    .default(REPO_SEARCH_RESULTS_DEFAULT),
});
export type RepoSearchArgs = z.infer<typeof repoSearchArgsSchema>;

export const repoSearchMatchSchema = z.object({
  path: z.string().min(1).max(512),
  line: z.number().int().positive(),
  text: z.string().max(REPO_SEARCH_LINE_MAX + 1),
});
export type RepoSearchMatch = z.infer<typeof repoSearchMatchSchema>;

export const repoSearchResultSchema = z.object({
  matches: z.array(repoSearchMatchSchema).max(REPO_SEARCH_RESULTS_MAX),
  /** More matches exist than were returned. */
  truncated: z.boolean(),
  /** Matches left out because their file is a secret or denied. */
  withheld: z.number().int().min(0),
});
export type RepoSearchResult = z.infer<typeof repoSearchResultSchema>;

// repo.read

/** Lines `startLine`…`endLine` of one file (1-based, inclusive), bounded. */
export const repoReadArgsSchema = z
  .strictObject({
    ...repoTarget,
    path: repoPathSchema,
    startLine: z.number().int().positive().default(1),
    endLine: z.number().int().positive().optional(),
  })
  .refine((a) => a.endLine === undefined || a.endLine >= a.startLine, {
    message: 'endLine must not be before startLine',
    path: ['endLine'],
  });
export type RepoReadArgs = z.infer<typeof repoReadArgsSchema>;

export const repoReadResultSchema = z.object({
  /** The file, relative to the checkout, as the runner resolved it. */
  path: z.string().min(1).max(512),
  content: z.string().max(REPO_READ_CHARS_MAX + 1),
  startLine: z.number().int().positive(),
  /** The last line returned; below `startLine` for an empty range. */
  endLine: z.number().int().min(0),
  totalLines: z.number().int().min(0),
  /** The range asked for was cut by the line or character cap. */
  truncated: z.boolean(),
});
export type RepoReadResult = z.infer<typeof repoReadResultSchema>;

// code.ask

/**
 * One headless Claude Code session in the checkout on `profileKey`, as a
 * Planner turn runs (ADR-0019): `--permission-mode plan`, with only the
 * Read, Grep and Glob tools, no MCP server, the project's own settings not
 * loaded, and secret and denied files refused by permission rules. It can
 * read; it cannot write a file or run a command. `runId` is the API's
 * `code_ask` run that books the session's spend.
 */
export const codeAskArgsSchema = z.strictObject({
  ...repoTarget,
  runId: skillRunIdSchema,
  sessionId: z.uuid(),
  profileKey: profileKeySchema,
  model: orchestratorModelSchema,
  question: z
    .string()
    .trim()
    .min(1)
    .max(CODE_ASK_QUESTION_MAX)
    .refine((q) => !q.includes('\u0000'), { message: 'must not contain NUL' }),
});
export type CodeAskArgs = z.infer<typeof codeAskArgsSchema>;

export const codeAskResultSchema = z.object({
  answer: z
    .string()
    .min(1)
    .max(CODE_ASK_ANSWER_MAX + 1),
  /** The answer was cut at `CODE_ASK_ANSWER_MAX`. */
  truncated: z.boolean(),
});
export type CodeAskResult = z.infer<typeof codeAskResultSchema>;

/** Reads need any member, as the assistant's read tools do. */
export const repoCommands = {
  'repo.search': {
    args: repoSearchArgsSchema,
    result: repoSearchResultSchema,
    minRole: 'viewer',
    timeoutMs: REPO_TIMEOUTS_MS.search,
  },
  'repo.read': {
    args: repoReadArgsSchema,
    result: repoReadResultSchema,
    minRole: 'viewer',
    timeoutMs: REPO_TIMEOUTS_MS.read,
  },
  'code.ask': {
    args: codeAskArgsSchema,
    result: codeAskResultSchema,
    minRole: 'viewer',
    timeoutMs: REPO_TIMEOUTS_MS.ask,
  },
} as const satisfies Record<string, CommandDefinition>;

export type RepoCommandName = keyof typeof repoCommands;
