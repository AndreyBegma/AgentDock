import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_READ_CHARS_MAX,
  REPO_READ_FILE_BYTES_MAX,
  REPO_READ_LINES_MAX,
  type RepoReadArgs,
  type RepoReadResult,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { readRegularFileInside } from '../fs/safe-read';
import { checkoutPath } from './paths';
import type { RepoDeps } from './types';

/**
 * Whether git knows `rel` in `root`: tracked, or untracked and not ignored.
 * An ignored file — a build output, a local config — is never read, so
 * what the checkout's `.gitignore` keeps out of git stays out of a reply.
 */
export const gitKnows = async (
  deps: Pick<RepoDeps, 'exec'>,
  root: string,
  rel: string,
): Promise<boolean> => {
  const listed = await deps.exec('git', [
    '-C',
    root,
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    `:(literal)${rel}`,
  ]);
  if (!listed || listed.code !== 0) return false;
  return listed.stdout.split('\0').includes(rel);
};

/**
 * `repo.read` (#622): lines of one file of the checkout, at most
 * `REPO_READ_LINES_MAX` lines and `REPO_READ_CHARS_MAX` characters. The file
 * must pass `checkoutPath`, be known to git, be a regular file (a symlink is
 * not followed) of at most `REPO_READ_FILE_BYTES_MAX`, and be text.
 */
export const repoRead = async (
  args: RepoReadArgs,
  deps: RepoDeps,
): Promise<RepoReadResult> => {
  const { root, rel } = checkoutPath(
    args,
    deps.watchedProjects(),
    deps.policy(),
  );
  if (rel === '' || lstatSync(join(root, rel)).isDirectory()) {
    throw new CommandFailure(
      'path_not_allowed',
      `${rel || '.'} is a directory; search it with repo.search`,
    );
  }
  if (!(await gitKnows(deps, root, rel))) {
    throw new CommandFailure(
      'path_not_allowed',
      `${rel} is ignored by git or not in the checkout`,
    );
  }
  const text = readRegularFileInside(root, rel, REPO_READ_FILE_BYTES_MAX);
  if (text === null) {
    throw new CommandFailure(
      'path_not_allowed',
      `${rel} is not a regular file of at most ${REPO_READ_FILE_BYTES_MAX} bytes`,
    );
  }
  if (text.includes('\u0000')) {
    throw new CommandFailure('unsupported', `${rel} is a binary file`);
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const totalLines = lines.length;
  const start = args.startLine;
  const asked = Math.min(args.endLine ?? totalLines, totalLines);
  const last = Math.min(asked, start + REPO_READ_LINES_MAX - 1);
  let content = '';
  let end = start - 1;
  let cut = false;
  for (let n = start; n <= last; n++) {
    const line = `${lines[n - 1]}\n`;
    if (content.length + line.length > REPO_READ_CHARS_MAX) break;
    content += line;
    end = n;
  }
  if (end < start && start <= asked) {
    // One line longer than the cap: its head, so a minified file still reads.
    content = lines[start - 1].slice(0, REPO_READ_CHARS_MAX);
    end = start;
    cut = true;
  }
  return {
    path: rel,
    content,
    startLine: start,
    endLine: end,
    totalLines,
    truncated: cut || end < asked,
  };
};
