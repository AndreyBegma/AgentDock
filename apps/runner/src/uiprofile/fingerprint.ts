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

/** A glob's syntax tree: `**\/` is `dirs`, a lone `**` is `globstar`. */
type GlobNode =
  | { kind: 'char'; char: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'dirs' }
  | { kind: 'alt'; branches: GlobNode[][] };

/** An unclosed `{` makes the whole glob literal text, not an alternation. */
const balanced = (glob: string): boolean => {
  let braces = 0;
  for (const char of glob) {
    if (char === '{') braces++;
    else if (char === '}' && braces > 0) braces--;
  }
  return braces === 0;
};

const parseGlob = (glob: string): GlobNode[] => {
  if (!balanced(glob)) {
    return glob.split('').map((char) => ({ kind: 'char', char }));
  }
  let i = 0;
  const sequence = (depth: number): GlobNode[] => {
    const nodes: GlobNode[] = [];
    while (i < glob.length) {
      const char = glob[i] as string;
      if (depth > 0 && (char === ',' || char === '}')) break;
      i++;
      if (char === '*') {
        if (glob[i] === '*') {
          const slash = glob[i + 1] === '/';
          nodes.push({ kind: slash ? 'dirs' : 'globstar' });
          i += slash ? 2 : 1;
        } else {
          nodes.push({ kind: 'star' });
        }
      } else if (char === '?') {
        nodes.push({ kind: 'any' });
      } else if (char === '{') {
        const branches = [sequence(depth + 1)];
        while (glob[i] === ',') {
          i++;
          branches.push(sequence(depth + 1));
        }
        i++; // the closing `}`: `balanced` guarantees it
        nodes.push({ kind: 'alt', branches });
      } else {
        nodes.push({ kind: 'char', char });
      }
    }
    return nodes;
  };
  return sequence(0);
};

/** What a character must be to follow an edge. */
const ACCEPTS_CHAR = 0;
const ACCEPTS_NOT_SLASH = 1;
const ACCEPTS_ANY = 2;
type Accepts =
  | typeof ACCEPTS_CHAR
  | typeof ACCEPTS_NOT_SLASH
  | typeof ACCEPTS_ANY;

interface NfaState {
  /** States reached without reading a character. */
  next: number[];
  /** States reached by reading a character the edge accepts. */
  edges: { accepts: Accepts; code: number; to: number }[];
}

const SLASH = 0x2f;

/** A compiled glob: `test` answers for one `/`-separated repository path. */
export interface GlobMatcher {
  test(path: string): boolean;
}

/**
 * A glob as a matcher over a `/`-separated repository path: `**` crosses
 * directories (`**\/` also matches none), `*` and `?` stay in one segment,
 * `{a,b}` alternates. Dotfiles match like any other file.
 *
 * The globs come from the server, so they are never handed to a backtracking
 * regex engine: the glob compiles to an NFA that is run over the path one
 * character at a time, tracking the set of live states. The time is at most
 * the path's length times the glob's — linear, whatever the glob.
 */
export const compileGlob = (glob: string): GlobMatcher => {
  const states: NfaState[] = [];
  const add = (): number => states.push({ next: [], edges: [] }) - 1;
  const edge = (from: number, accepts: Accepts, to: number, code = 0) =>
    states[from]?.edges.push({ accepts, code, to });
  const jump = (from: number, to: number) => states[from]?.next.push(to);

  const build = (nodes: GlobNode[], from: number): number => {
    let at = from;
    for (const node of nodes) {
      const to = add();
      switch (node.kind) {
        case 'char':
          edge(at, ACCEPTS_CHAR, to, node.char.charCodeAt(0));
          break;
        case 'any':
          edge(at, ACCEPTS_NOT_SLASH, to);
          break;
        case 'star':
        case 'globstar':
          jump(at, to);
          edge(to, node.kind === 'star' ? ACCEPTS_NOT_SLASH : ACCEPTS_ANY, to);
          break;
        case 'dirs': {
          // `(?:.*/)?`: nothing, or anything that ends with `/`.
          const inside = add();
          jump(at, to);
          jump(at, inside);
          edge(inside, ACCEPTS_ANY, inside);
          edge(inside, ACCEPTS_CHAR, to, SLASH);
          break;
        }
        case 'alt':
          for (const branch of node.branches) {
            const start = add();
            jump(at, start);
            jump(build(branch, start), to);
          }
          break;
      }
      at = to;
    }
    return at;
  };
  const start = add();
  const accept = build(parseGlob(glob), start);

  // Flat arrays for the hot loop: state `s` owns edges and jumps
  // `[first[s], first[s + 1])`.
  const size = states.length;
  const edgeFirst = new Int32Array(size + 1);
  const jumpFirst = new Int32Array(size + 1);
  const edgeAccepts: number[] = [];
  const edgeCode: number[] = [];
  const edgeTo: number[] = [];
  const jumpTo: number[] = [];
  states.forEach((state, s) => {
    edgeFirst[s] = edgeTo.length;
    jumpFirst[s] = jumpTo.length;
    for (const e of state.edges) {
      edgeAccepts.push(e.accepts);
      edgeCode.push(e.code);
      edgeTo.push(e.to);
    }
    jumpTo.push(...state.next);
  });
  edgeFirst[size] = edgeTo.length;
  jumpFirst[size] = jumpTo.length;

  return {
    test: (path) => {
      // `mark[s] === generation`: `s` is already in `next`.
      const mark = new Int32Array(size).fill(-1);
      const live = new Int32Array(size);
      const next = new Int32Array(size);
      let liveCount = 0;
      let accepted = false;
      // Closes `next[0..count)` over jumps, then keeps in `live` only the
      // states a character can leave — the rest have done their part.
      const settle = (count: number, generation: number): void => {
        accepted = false;
        liveCount = 0;
        for (let k = 0; k < count; k++) {
          const s = next[k] as number;
          if (s === accept) accepted = true;
          const jumpEnd = jumpFirst[s + 1] as number;
          for (let j = jumpFirst[s] as number; j < jumpEnd; j++) {
            const to = jumpTo[j] as number;
            if (mark[to] === generation) continue;
            mark[to] = generation;
            next[count++] = to;
          }
          if ((edgeFirst[s + 1] as number) > (edgeFirst[s] as number)) {
            live[liveCount++] = s;
          }
        }
      };
      mark[start] = 0;
      next[0] = start;
      settle(1, 0);
      for (let i = 0; i < path.length; i++) {
        const code = path.charCodeAt(i);
        const generation = i + 1;
        let nextCount = 0;
        for (let k = 0; k < liveCount; k++) {
          const s = live[k] as number;
          const edgeEnd = edgeFirst[s + 1] as number;
          for (let e = edgeFirst[s] as number; e < edgeEnd; e++) {
            const accepts = edgeAccepts[e];
            const ok =
              accepts === ACCEPTS_ANY ||
              (accepts === ACCEPTS_NOT_SLASH
                ? code !== SLASH
                : code === edgeCode[e]);
            const to = edgeTo[e] as number;
            if (!ok || mark[to] === generation) continue;
            mark[to] = generation;
            next[nextCount++] = to;
          }
        }
        if (nextCount === 0) return false;
        settle(nextCount, generation);
      }
      return accepted;
    },
  };
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
  const matchers = args.globs.map(compileGlob);

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
