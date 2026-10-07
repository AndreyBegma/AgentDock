import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  DOCS_RULES,
  type DocsCandidate,
  type DocsEvidence,
  type DocsRule,
  type DocsSource,
  type DocsSourceKind,
} from '@agentdock/shared/protocol';
import type { Exec } from '../detect/exec';
import { classifyDocs, emptyClassified } from './classify';
import { isDirectory, type ProjectFs } from './fs';
import { githubRepoIn, nameOf, ownerOf, parseRemote } from './remote';

/** Files rule 4 reads, at the project root. */
export const TEXT_LINK_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md'];
/** Sibling suffixes rules 2, 3 and 5 look for. */
export const DOCS_SUFFIXES = ['-documentation', '-docs'];
const DOCS_WORD = /docs|documentation/i;

export interface DetectDocsInput {
  /** The main checkout, absolute and real. */
  root: string;
  /** The project's `owner/name`, null when it is not on GitHub. */
  repo: string | null;
  /** `orchestrator.specDir` from `.code-analyzer-config.json`. */
  specDir?: string;
  /** Where `specDir` was read from, for evidence. */
  configFile: string;
  fs: ProjectFs;
  exec: Exec;
}

export interface DetectedDocs {
  docs: DocsSource;
  warnings: string[];
}

interface Hit {
  kind: Exclude<DocsSourceKind, 'none'>;
  localPath: string | null;
  /** The docs repository when the rule named it (a URL). */
  repo?: string;
  evidence: DocsEvidence[];
}

/** 1-based line of the first line containing `needle`, if any. */
const lineOf = (text: string, needle: string): number | undefined => {
  const index = text.split('\n').findIndex((l) => l.includes(needle));
  return index === -1 ? undefined : index + 1;
};

const isUnder = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir + sep);

/**
 * D6: finds where a project's documentation lives. Rules run in order and
 * stop at the first hit; every candidate checked is returned. D8: reads only
 * the root, its parent's direct children (and their `README.md`), and the
 * docs root that was found.
 */
export const detectDocs = async (
  input: DetectDocsInput,
): Promise<DetectedDocs> => {
  const { root, repo, fs, exec } = input;
  const parent = dirname(root);
  const name = basename(root);
  const candidates: DocsCandidate[] = [];
  const warnings: string[] = [];

  const check = (rule: DocsRule, target: string, hit: boolean): boolean => {
    candidates.push({ rule, target, hit });
    return hit;
  };

  /**
   * A direct child of the parent, as a directory — or null. A symlinked
   * sibling is followed only when its target is also a direct child of the
   * parent (D10): a link must not lead detection anywhere else.
   */
  const sibling = (path: string): string | null => {
    if (dirname(path) !== parent || path === root) return null;
    if (fs.isSymbolicLink(path)) {
      const real = fs.realpath(path);
      if (!real || dirname(real) !== parent) {
        warnings.push(`${path} is a symlink out of ${parent}; not followed.`);
        return null;
      }
    }
    return isDirectory(fs, path) ? path : null;
  };

  /** The direct child of the parent that `path` sits in, or null. */
  const siblingRootOf = (path: string): string | null => {
    if (!isUnder(path, parent) || path === parent) return null;
    const first = relative(parent, path).split(sep)[0];
    return join(parent, first);
  };

  /** A same-owner GitHub repo: a local clone beside the project, or remote. */
  const repoHit = (docsRepo: string, evidence: DocsEvidence[]): Hit => {
    const clone = sibling(join(parent, nameOf(docsRepo)));
    return clone
      ? { kind: 'sibling_repo', localPath: clone, repo: docsRepo, evidence }
      : { kind: 'remote_repo', localPath: null, repo: docsRepo, evidence };
  };

  const specDirRule = (): Hit | null => {
    const { specDir, configFile } = input;
    if (specDir === undefined) return null;
    const configText = fs.readFile(configFile) ?? '';
    const evidence: DocsEvidence[] = [
      { file: configFile, line: lineOf(configText, '"specDir"') },
    ];
    const url = githubRepoIn(specDir);
    if (url) {
      check('spec_dir', url, true);
      return repoHit(url, [...evidence, { url: specDir }]);
    }
    const target = resolve(root, specDir);
    if (isUnder(target, root)) {
      // `docs/specs` → `docs`; a single segment means the repo itself.
      const segments = relative(root, target).split(sep).filter(Boolean);
      const docsRoot = segments.length >= 2 ? join(root, segments[0]) : root;
      if (!check('spec_dir', target, isDirectory(fs, docsRoot))) return null;
      return { kind: 'in_repo', localPath: docsRoot, evidence };
    }
    const docsRoot = siblingRootOf(target);
    if (!docsRoot) {
      check('spec_dir', target, false);
      warnings.push(
        `specDir ${specDir} is outside ${parent}; it was not read.`,
      );
      return null;
    }
    if (!check('spec_dir', target, sibling(docsRoot) !== null)) {
      warnings.push(`specDir ${specDir} does not exist.`);
      return null;
    }
    return { kind: 'sibling_repo', localPath: docsRoot, evidence };
  };

  const siblingRule = (): Hit | null => {
    for (const suffix of DOCS_SUFFIXES) {
      const path = join(parent, `${name}${suffix}`);
      if (check('sibling', path, sibling(path) !== null)) {
        return {
          kind: 'sibling_repo',
          localPath: path,
          evidence: [{ file: path }],
        };
      }
    }
    return null;
  };

  /** Rule 3: at most two `gh repo view` calls, each bounded by Exec's timeout. */
  const sameOwnerRule = async (): Promise<Hit | null> => {
    if (!repo) return null;
    for (const suffix of DOCS_SUFFIXES) {
      const target = `${ownerOf(repo)}/${nameOf(repo)}${suffix}`;
      const result = await exec('gh', [
        'repo',
        'view',
        target,
        '--json',
        'nameWithOwner',
        '--jq',
        '.nameWithOwner',
      ]);
      const found = result?.code === 0 && result.stdout.trim() === target;
      if (check('same_owner_remote', target, found)) {
        return repoHit(target, [{ url: `https://github.com/${target}` }]);
      }
    }
    return null;
  };

  /**
   * Rule 4: GitHub URLs and local paths naming docs in the root's agent
   * files. A URL counts when it is the same owner's repo or has a clone
   * beside the project; a path counts when it resolves to a sibling folder.
   */
  const textLinkRule = (): Hit | null => {
    for (const file of TEXT_LINK_FILES) {
      const path = join(root, file);
      const text = fs.readFile(path);
      if (text === null) continue;
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const evidence: DocsEvidence = { file: path, line: index + 1 };
        for (const token of line.split(/[\s()<>[\]"'`,|]+/)) {
          const hit = textLinkTarget(token.replace(/[.:;]+$/, ''), evidence);
          if (hit) return hit;
        }
      }
    }
    return null;
  };

  const textLinkTarget = (
    token: string,
    evidence: DocsEvidence,
  ): Hit | null => {
    if (!DOCS_WORD.test(token)) return null;
    const url = token.includes('github.com') ? githubRepoIn(token) : null;
    if (url) {
      if (!DOCS_WORD.test(nameOf(url))) return null;
      const clone = sibling(join(parent, nameOf(url)));
      const sameOwner = repo !== null && ownerOf(url) === ownerOf(repo);
      if (!check('text_link', url, clone !== null || sameOwner)) return null;
      return repoHit(url, [evidence, { url: token }]);
    }
    if (token.includes('://')) return null;
    if (!/^(\.\.?\/|\/)/.test(token)) return null;
    const docsRoot = siblingRootOf(resolve(root, token));
    if (!docsRoot || !DOCS_WORD.test(basename(docsRoot))) return null;
    if (!check('text_link', docsRoot, sibling(docsRoot) !== null)) return null;
    return { kind: 'sibling_repo', localPath: docsRoot, evidence: [evidence] };
  };

  /** Rule 5: a `*-documentation` / `*-docs` sibling whose README names this project. */
  const backLinkRule = (): Hit | null => {
    const word = new RegExp(
      `(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`,
    );
    const names = (line: string): boolean =>
      (repo !== null && line.includes(repo)) ||
      line.includes(root) ||
      word.test(line);
    const folders = fs
      .readdir(parent)
      .map((e) => e.name)
      .filter((n) => DOCS_SUFFIXES.some((s) => n.endsWith(s)) && n !== name)
      .sort();
    for (const folder of folders) {
      const dir = sibling(join(parent, folder));
      if (!dir) continue;
      const readme = join(dir, 'README.md');
      const lines = (fs.readFile(readme) ?? '').split('\n');
      const index = lines.findIndex(names);
      if (check('back_link', dir, index !== -1)) {
        return {
          kind: 'sibling_repo',
          localPath: dir,
          evidence: [{ file: readme, line: index + 1 }],
        };
      }
    }
    return null;
  };

  const inRepoRule = (): Hit | null => {
    const path = join(root, 'docs');
    if (!check('in_repo', path, isDirectory(fs, path))) return null;
    return { kind: 'in_repo', localPath: path, evidence: [{ file: path }] };
  };

  const rules: Record<DocsRule, () => Hit | null | Promise<Hit | null>> = {
    spec_dir: specDirRule,
    sibling: siblingRule,
    same_owner_remote: sameOwnerRule,
    text_link: textLinkRule,
    back_link: backLinkRule,
    in_repo: inRepoRule,
  };
  for (const rule of DOCS_RULES) {
    const hit = await rules[rule]();
    if (!hit) continue;
    return {
      docs: await describe(hit, rule, input, candidates, warnings),
      warnings,
    };
  }
  warnings.push(
    'No documentation source found; connect it anyway or set one manually.',
  );
  return {
    docs: {
      kind: 'none',
      localPath: null,
      repo: null,
      isGitRepo: false,
      detectedBy: null,
      evidence: [],
      classified: emptyClassified(),
      candidates,
    },
    warnings,
  };
};

/** Fills in the found source: git-ness, its repo, and its classification. */
const describe = async (
  hit: Hit,
  detectedBy: DocsRule,
  input: DetectDocsInput,
  candidates: DocsCandidate[],
  warnings: string[],
): Promise<DocsSource> => {
  const { fs, exec } = input;
  const base = {
    kind: hit.kind,
    detectedBy,
    evidence: hit.evidence,
    candidates,
  };
  if (hit.localPath === null) {
    warnings.push(
      `Documentation is in ${hit.repo} with no clone beside the project; clone it into ${dirname(input.root)} to classify it.`,
    );
    return {
      ...base,
      localPath: null,
      repo: hit.repo ?? null,
      isGitRepo: true,
      classified: emptyClassified(),
    };
  }
  if (hit.kind === 'in_repo') {
    return {
      ...base,
      localPath: hit.localPath,
      repo: input.repo,
      isGitRepo: true,
      classified: classifyDocs(fs, hit.localPath),
    };
  }
  const isGitRepo = fs.stat(join(hit.localPath, '.git')) !== null;
  let repo = hit.repo ?? null;
  if (repo === null && isGitRepo) {
    const origin = await exec('git', [
      '-C',
      hit.localPath,
      'remote',
      'get-url',
      'origin',
    ]);
    if (origin?.code === 0) repo = parseRemote(origin.stdout).repo;
  }
  return {
    ...base,
    localPath: hit.localPath,
    repo,
    isGitRepo,
    classified: classifyDocs(fs, hit.localPath),
  };
};
