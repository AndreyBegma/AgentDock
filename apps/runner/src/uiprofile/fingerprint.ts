import { createHash } from 'node:crypto';
import {
  UIPROFILE_FINGERPRINT_MAX_FILES,
  UIPROFILE_FINGERPRINT_MAX_GLOBS,
} from '@nautelle/shared';
import type {
  UiProfileFingerprintArgs,
  UiProfileFingerprintResult,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import {
  NETWORK_TIMEOUT_MS,
  type SkillsDeps,
  stderrLine,
} from '../skills/deps';

type FingerprintDeps = Pick<SkillsDeps, 'exec' | 'watchedProjects'>;

/** `ls-tree -r` of a large repository is long; local git, so well under a minute. */
const LS_TREE_TIMEOUT_MS = 45_000;

/**
 * The runner's own check, beside the schema's: a glob is repository-relative
 * and confined to the project root. Defence in depth — the matcher below never
 * touches the filesystem, but a glob that names a parent is refused anyway.
 */
export const assertConfinedGlob = (glob: string): void => {
  if (
    glob.startsWith('/') ||
    /^[A-Za-z]:/.test(glob) ||
    glob.includes('\\') ||
    glob.split('/').some((segment) => segment === '..')
  ) {
    throw new CommandFailure(
      'path_not_allowed',
      `glob ${JSON.stringify(glob)} must be repository-relative, without ".." or an absolute path`,
    );
  }
};

const escapeRegex = (char: string): string =>
  /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;

/**
 * A glob as a regular expression over a `/`-separated repository path:
 * `**` crosses directories (`**\/` also matches none), `*` and `?` stay in
 * one segment, `{a,b}` alternates. Dotfiles match like any other file.
 */
export const globToRegExp = (glob: string): RegExp => {
  let source = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      braces++;
      source += '(?:';
    } else if (char === '}' && braces > 0) {
      braces--;
      source += ')';
    } else if (char === ',' && braces > 0) {
      source += '|';
    } else {
      source += escapeRegex(char);
    }
  }
  // An unclosed `{` is literal text, not an alternation.
  return braces > 0
    ? new RegExp(`^${glob.split('').map(escapeRegex).join('')}$`)
    : new RegExp(`^${source}$`);
};

interface TreeFile {
  path: string;
  blob: string;
}

/** Regular files (modes 100644 / 100755) of `ls-tree -r -z`; links and submodules are skipped. */
const parseLsTree = (output: string): TreeFile[] => {
  const files: TreeFile[] = [];
  for (const entry of output.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, blob] = entry.slice(0, tab).split(' ');
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    if (!blob) continue;
    files.push({ path: entry.slice(tab + 1), blob });
  }
  return files;
};

/**
 * `uiprofile.fingerprint` (D13): SHA-256 over the sorted `path:<blob id>`
 * lines of the files matching `globs` at `origin/<base>`, read from git's
 * object database — never from the working copy, which may hold the
 * person's unsaved changes. A blob id names the file's content, so a changed
 * file changes the hash exactly as hashing its bytes would.
 */
export const fingerprint = async (
  args: UiProfileFingerprintArgs,
  deps: FingerprintDeps,
): Promise<UiProfileFingerprintResult> => {
  const { exec } = deps;
  const project = watchedProject(args, deps.watchedProjects());
  if (args.globs.length > UIPROFILE_FINGERPRINT_MAX_GLOBS) {
    throw new CommandFailure(
      'too_large',
      `at most ${UIPROFILE_FINGERPRINT_MAX_GLOBS} globs`,
    );
  }
  for (const glob of args.globs) assertConfinedGlob(glob);
  const matchers = args.globs.map(globToRegExp);

  // Best effort: an unreachable origin still answers for the base it last fetched.
  await exec(
    'git',
    ['-C', project.root, 'fetch', '--quiet', 'origin', args.base],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  const rev = await exec('git', [
    '-C',
    project.root,
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${args.base}^{commit}`,
  ]);
  if (!rev || rev.code !== 0) {
    throw new CommandFailure(
      'not_found',
      `origin/${args.base} does not exist in ${project.root}`,
    );
  }
  const tree = await exec(
    'git',
    [
      '-C',
      project.root,
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      rev.stdout.trim(),
    ],
    { timeoutMs: LS_TREE_TIMEOUT_MS },
  );
  if (!tree || tree.code !== 0) {
    throw new Error(`git ls-tree failed: ${stderrLine(tree)}`);
  }

  const matched = parseLsTree(tree.stdout).filter((file) =>
    matchers.some((m) => m.test(file.path)),
  );
  if (matched.length > UIPROFILE_FINGERPRINT_MAX_FILES) {
    throw new CommandFailure(
      'too_large',
      `the globs match more than ${UIPROFILE_FINGERPRINT_MAX_FILES} files`,
    );
  }
  const lines = matched
    .map((file) => `${file.path}:${file.blob}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    fingerprint: createHash('sha256').update(lines.join('\n')).digest('hex'),
    files: matched.length,
  };
};
