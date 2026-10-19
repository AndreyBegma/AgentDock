import {
  REPO_SEARCH_LINE_MAX,
  type RepoSearchArgs,
  type RepoSearchMatch,
  type RepoSearchResult,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { stderrLine } from '../skills/deps';
import { checkoutPath, SECRET_NAME_GLOBS, withheldReason } from './paths';
import type { RepoDeps } from './types';

/** At most this many matches of one file, so one file cannot fill a reply. */
const PER_FILE_MAX = 20;
/** `git grep` gives up after this long; the command's timeout is longer. */
const GREP_TIMEOUT_MS = 15_000;

/**
 * Pathspecs that keep secrets out of `git grep` itself. The result is still
 * filtered by `withheldReason`, which also applies the policy's patterns and
 * matches case-insensitively; these only spare the work.
 */
const SECRET_EXCLUDES = SECRET_NAME_GLOBS.flatMap((g) => [
  `:(exclude,glob)**/${g}`,
  `:(exclude,glob)**/${g}/**`,
]);

const cutLine = (text: string): string =>
  text.length > REPO_SEARCH_LINE_MAX
    ? `${text.slice(0, REPO_SEARCH_LINE_MAX)}…`
    : text;

/** `git grep -z -n` output: `path\0line\0text` per line. */
export const parseGrep = (stdout: string): RepoSearchMatch[] => {
  const matches: RepoSearchMatch[] = [];
  for (const row of stdout.split('\n')) {
    const first = row.indexOf('\0');
    const second = first < 0 ? -1 : row.indexOf('\0', first + 1);
    if (second < 0) continue;
    const line = Number(row.slice(first + 1, second));
    if (!Number.isInteger(line) || line < 1) continue;
    matches.push({
      path: row.slice(0, first),
      line,
      text: cutLine(row.slice(second + 1)),
    });
  }
  return matches;
};

/**
 * `repo.search` (#622): `git grep` over the files git knows in the checkout
 * (tracked, and untracked ones it does not ignore), binary files skipped.
 * A match in a secret or denied file is withheld and only counted.
 */
export const repoSearch = async (
  args: RepoSearchArgs,
  deps: RepoDeps,
): Promise<RepoSearchResult> => {
  const policy = deps.policy();
  const { root, rel } = checkoutPath(args, deps.watchedProjects(), policy);
  const result = await deps.exec(
    'git',
    [
      '-C',
      root,
      'grep',
      '--untracked',
      '-I',
      '-n',
      '-z',
      '--no-color',
      '--full-name',
      `--max-count=${PER_FILE_MAX}`,
      args.regex ? '-E' : '-F',
      ...(args.caseSensitive ? [] : ['-i']),
      '-e',
      args.query,
      '--',
      rel === '' ? '.' : `:(literal)${rel}`,
      ...SECRET_EXCLUDES,
    ],
    { timeoutMs: GREP_TIMEOUT_MS },
  );
  if (!result) {
    throw new Error('git grep is not available or timed out');
  }
  // 1: no match.
  if (result.code === 1 && result.stdout === '') {
    return { matches: [], truncated: false, withheld: 0 };
  }
  if (result.code !== 0) {
    throw new CommandFailure(
      'invalid_args',
      `the search failed: ${stderrLine(result)}`,
    );
  }
  const matches: RepoSearchMatch[] = [];
  let withheld = 0;
  let truncated = false;
  for (const match of parseGrep(result.stdout)) {
    if (withheldReason(match.path, policy) !== null) {
      withheld++;
      continue;
    }
    if (matches.length >= args.maxResults) {
      truncated = true;
      continue;
    }
    matches.push(match);
  }
  return { matches, truncated, withheld };
};
