import { afterEach, describe, expect, it } from 'bun:test';
import { symlinkSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  type DocsCandidate,
  docsSourceSchema,
} from '@agentdock/shared/protocol';
import type { Exec } from '../detect/exec';
import {
  type FsAccess,
  gitWithFakeGh,
  spyFs,
  workspace,
} from '../testing/projects';
import { classifyDocs } from './classify';
import { detectDocs } from './docs';
import { nodeFs } from './fs';

const REPO = 'acme/x';
const NO_GH_HIT = (repo: string): DocsCandidate[] => [
  { rule: 'same_owner_remote', target: `${repo}-documentation`, hit: false },
  { rule: 'same_owner_remote', target: `${repo}-docs`, hit: false },
];

let ws: ReturnType<typeof workspace>;
afterEach(() => ws?.cleanup());

/** A project `x` on GitHub as `acme/x`, inside a fresh workspace. */
const project = async (files: Record<string, string> = {}) => {
  ws = workspace();
  const root = await ws.repo('x', `git@github.com:${REPO}.git`);
  ws.files(files);
  const sibling = (suffix: string) => join(ws.ws, `x${suffix}`);
  return { root, parent: ws.ws, sibling };
};

const detect = async (
  root: string,
  options: { specDir?: string; repo?: string | null; exec?: Exec } = {},
) => {
  const spy = spyFs();
  const execPaths: string[] = [];
  const exec = options.exec ?? gitWithFakeGh(ws.git);
  const result = await detectDocs({
    root,
    repo: options.repo === undefined ? REPO : options.repo,
    specDir: options.specDir,
    configFile: join(root, '.code-analyzer-config.json'),
    fs: spy.fs,
    exec: (binary, args) => {
      if (args[0] === '-C') execPaths.push(args[1]);
      return exec(binary, args);
    },
  });
  docsSourceSchema.parse(result.docs);
  return { ...result, accesses: spy.accesses, execPaths };
};

/**
 * D8: a path detection may touch — the root and below, the parent itself, a
 * direct child of the parent, a sibling's README.md, or the docs root to
 * depth 2.
 */
const allowed = (
  path: string,
  root: string,
  docsRoot: string | null,
): boolean => {
  const parent = dirname(root);
  const under = (dir: string) => path === dir || path.startsWith(dir + sep);
  if (under(root) || path === parent || dirname(path) === parent) return true;
  if (dirname(dirname(path)) === parent && basename(path) === 'README.md') {
    return true;
  }
  if (docsRoot && under(docsRoot)) {
    return relative(docsRoot, path).split(sep).length <= 2;
  }
  return false;
};

const expectConfined = (
  accesses: FsAccess[],
  execPaths: string[],
  root: string,
  docsRoot: string | null,
) => {
  const outside = [...accesses.map((a) => a.path), ...execPaths].filter(
    (p) => !allowed(p, root, docsRoot),
  );
  expect(accesses.length).toBeGreaterThan(0);
  expect(outside).toEqual([]);
};

describe('the D8 confinement check', () => {
  it('rejects what detection must not touch', () => {
    const root = '/w/x';
    expect(allowed('/w/other-docs/specs/a.md', root, null)).toBe(false);
    expect(allowed('/elsewhere', root, null)).toBe(false);
    expect(allowed('/w/d/a/b/c', root, '/w/d')).toBe(false);
    expect(allowed('/w/d/a/b', root, '/w/d')).toBe(true);
    expect(allowed('/w/other-docs/README.md', root, null)).toBe(true);
  });
});

describe('docs detection (D6)', () => {
  it('rule 1, spec_dir: `../x-documentation/prs` points at a sibling git repo', async () => {
    const { root, sibling } = await project({
      'x/.code-analyzer-config.json':
        '{\n  "orchestrator": {\n    "specDir": "../x-documentation/prs"\n  }\n}\n',
      'x-documentation/prs/': '',
      'x-documentation/adr/': '',
      'x-documentation/roadmap.md': '# roadmap',
      'x-documentation/fixes/': '',
      'x-documentation/notes.md': '',
    });
    await ws.repo(
      'x-documentation',
      'https://github.com/acme/x-documentation.git',
    );

    const { docs, accesses, execPaths } = await detect(root, {
      specDir: '../x-documentation/prs',
    });

    expect(docs).toEqual({
      kind: 'sibling_repo',
      localPath: sibling('-documentation'),
      repo: 'acme/x-documentation',
      isGitRepo: true,
      detectedBy: 'spec_dir',
      evidence: [{ file: join(root, '.code-analyzer-config.json'), line: 3 }],
      classified: {
        specs: ['prs'],
        adr: ['adr'],
        roadmap: ['roadmap.md'],
        reports: ['fixes'],
      },
      candidates: [
        {
          rule: 'spec_dir',
          target: join(sibling('-documentation'), 'prs'),
          hit: true,
        },
      ],
    });
    expectConfined(accesses, execPaths, root, sibling('-documentation'));
  });

  it('rule 1, spec_dir: an in-repo `docs/specs` is in_repo with docs/ as the root', async () => {
    const { root } = await project({
      'x/docs/specs/': '',
      'x/docs/decisions.md': '',
    });
    const { docs } = await detect(root, { specDir: 'docs/specs' });
    expect(docs).toMatchObject({
      kind: 'in_repo',
      localPath: join(root, 'docs'),
      repo: REPO,
      detectedBy: 'spec_dir',
      classified: { specs: ['specs'], adr: ['decisions.md'] },
    });
  });

  it('rule 1, spec_dir: a GitHub URL with no clone beside the project is remote_repo', async () => {
    const { root } = await project();
    const { docs, warnings } = await detect(root, {
      specDir: 'https://github.com/acme/handbook/tree/main/specs',
    });
    expect(docs).toMatchObject({
      kind: 'remote_repo',
      localPath: null,
      repo: 'acme/handbook',
      isGitRepo: true,
      detectedBy: 'spec_dir',
      candidates: [{ rule: 'spec_dir', target: 'acme/handbook', hit: true }],
    });
    expect(warnings.join('\n')).toContain('clone it into');
  });

  it('rule 1, spec_dir: a path out of the parent is not read and detection goes on', async () => {
    const { root, parent } = await project({ 'x/docs/': '' });
    const { docs, warnings, accesses, execPaths } = await detect(root, {
      specDir: '../../elsewhere/specs',
    });
    expect(docs.candidates[0]).toEqual({
      rule: 'spec_dir',
      target: join(dirname(parent), 'elsewhere', 'specs'),
      hit: false,
    });
    expect(docs.detectedBy).toBe('in_repo');
    expect(warnings.join('\n')).toContain('was not read');
    expectConfined(accesses, execPaths, root, join(root, 'docs'));
  });

  it('rule 2, sibling: a non-git `x-docs` beside the project', async () => {
    const { root, sibling } = await project({
      'x-docs/specs/': '',
      'x-docs/bug-reports/': '',
      'x-docs/docs/specs/': '',
      'x-docs/docs/roadmap-2027.md': '',
      'x/docs/': '',
    });

    const { docs, accesses, execPaths } = await detect(root);

    expect(docs).toEqual({
      kind: 'sibling_repo',
      localPath: sibling('-docs'),
      repo: null,
      isGitRepo: false,
      detectedBy: 'sibling',
      evidence: [{ file: sibling('-docs') }],
      classified: {
        specs: ['docs/specs', 'specs'],
        adr: [],
        roadmap: ['docs/roadmap-2027.md'],
        reports: ['bug-reports'],
      },
      candidates: [
        { rule: 'sibling', target: sibling('-documentation'), hit: false },
        { rule: 'sibling', target: sibling('-docs'), hit: true },
      ],
    });
    expectConfined(accesses, execPaths, root, sibling('-docs'));
  });

  it('rule 2, sibling: a symlink out of the parent is not followed', async () => {
    const { root, sibling } = await project({ 'x/docs/': '' });
    const outside = workspace();
    try {
      outside.files({ 'secret/specs/': '' });
      symlinkSync(join(outside.ws, 'secret'), sibling('-documentation'));
      const { docs, warnings, accesses } = await detect(root);
      expect(docs.candidates[0]).toEqual({
        rule: 'sibling',
        target: sibling('-documentation'),
        hit: false,
      });
      expect(docs.detectedBy).toBe('in_repo');
      expect(warnings.join('\n')).toContain('not followed');
      expect(accesses.filter((a) => a.path.startsWith(outside.ws))).toEqual([]);
    } finally {
      outside.cleanup();
    }
  });

  it('rule 3, same_owner_remote: `gh` finds acme/x-docs and there is no clone', async () => {
    const { root, sibling } = await project({ 'x/docs/': '' });
    const exec = gitWithFakeGh(ws.git, {
      'repo view acme/x-docs --json nameWithOwner --jq .nameWithOwner':
        'acme/x-docs',
    });

    const { docs } = await detect(root, { exec });

    expect(docs).toMatchObject({
      kind: 'remote_repo',
      localPath: null,
      repo: 'acme/x-docs',
      detectedBy: 'same_owner_remote',
      evidence: [{ url: 'https://github.com/acme/x-docs' }],
      candidates: [
        { rule: 'sibling', target: sibling('-documentation'), hit: false },
        { rule: 'sibling', target: sibling('-docs'), hit: false },
        {
          rule: 'same_owner_remote',
          target: 'acme/x-documentation',
          hit: false,
        },
        { rule: 'same_owner_remote', target: 'acme/x-docs', hit: true },
      ],
    });
  });

  it('rule 4, text_link: a sibling named only in AGENTS.md', async () => {
    const { root, parent, sibling } = await project({
      'x/AGENTS.md':
        '# Agents\n\nRead the docs first.\nSpecs: [acme-documentation](https://github.com/acme/acme-documentation).\n',
      'x/CLAUDE.md': 'See https://example.com/docs/ for the API.\n',
      'acme-documentation/stages/': '',
      'acme-documentation/decisions/': '',
      'acme-documentation/spec-queue.md': '',
      'x/docs/': '',
    });
    await ws.repo('acme-documentation');
    const docsRoot = join(parent, 'acme-documentation');

    const { docs, accesses, execPaths } = await detect(root);

    expect(docs).toEqual({
      kind: 'sibling_repo',
      localPath: docsRoot,
      repo: 'acme/acme-documentation',
      isGitRepo: true,
      detectedBy: 'text_link',
      evidence: [
        { file: join(root, 'AGENTS.md'), line: 4 },
        { url: 'https://github.com/acme/acme-documentation' },
      ],
      classified: {
        specs: ['stages'],
        adr: ['decisions'],
        roadmap: ['spec-queue.md'],
        reports: [],
      },
      candidates: [
        { rule: 'sibling', target: sibling('-documentation'), hit: false },
        { rule: 'sibling', target: sibling('-docs'), hit: false },
        ...NO_GH_HIT(REPO),
        { rule: 'text_link', target: 'acme/acme-documentation', hit: true },
      ],
    });
    expectConfined(accesses, execPaths, root, docsRoot);
  });

  it('rule 4, text_link: a relative path to a sibling counts, a path out of the parent does not', async () => {
    const { root, parent } = await project({
      'x/README.md':
        'Old notes in ../../archive/docs.\nCurrent: ../handbook-documentation/specs\n',
      'handbook-documentation/specs/': '',
    });
    const { docs } = await detect(root);
    expect(docs).toMatchObject({
      kind: 'sibling_repo',
      localPath: join(parent, 'handbook-documentation'),
      detectedBy: 'text_link',
      evidence: [{ file: join(root, 'README.md'), line: 2 }],
    });
  });

  it('rule 5, back_link: a non-git `*-docs` sibling whose README names the project', async () => {
    const { root, parent, sibling } = await project({
      'aaa-docs/README.md': '# Docs for the xylophone app\n',
      'handbook-docs/README.md':
        '# Handbook\n\nDocumentation for acme/x — the X app.\n',
      'handbook-docs/specs/': '',
      'handbook-docs/feature-plans/': '',
      'handbook-docs/private/deep/secret.md': 'never read',
    });
    const docsRoot = join(parent, 'handbook-docs');

    const { docs, accesses, execPaths } = await detect(root);

    expect(docs).toEqual({
      kind: 'sibling_repo',
      localPath: docsRoot,
      repo: null,
      isGitRepo: false,
      detectedBy: 'back_link',
      evidence: [{ file: join(docsRoot, 'README.md'), line: 3 }],
      classified: {
        specs: ['specs'],
        adr: [],
        roadmap: [],
        reports: ['feature-plans'],
      },
      candidates: [
        { rule: 'sibling', target: sibling('-documentation'), hit: false },
        { rule: 'sibling', target: sibling('-docs'), hit: false },
        ...NO_GH_HIT(REPO),
        { rule: 'back_link', target: join(parent, 'aaa-docs'), hit: false },
        { rule: 'back_link', target: docsRoot, hit: true },
      ],
    });
    expectConfined(accesses, execPaths, root, docsRoot);
    expect(accesses.map((a) => a.path)).not.toContain(
      join(docsRoot, 'private', 'deep', 'secret.md'),
    );
  });

  it('rule 6, in_repo: only a docs/ folder', async () => {
    const { root, sibling } = await project({
      'x/docs/specs/': '',
      'x/docs/adr/': '',
      'x/docs/ROADMAP.md': '',
      'x/docs/verifications/': '',
    });

    const { docs, accesses, execPaths } = await detect(root);

    expect(docs).toEqual({
      kind: 'in_repo',
      localPath: join(root, 'docs'),
      repo: REPO,
      isGitRepo: true,
      detectedBy: 'in_repo',
      evidence: [{ file: join(root, 'docs') }],
      classified: {
        specs: ['specs'],
        adr: ['adr'],
        roadmap: ['ROADMAP.md'],
        reports: ['verifications'],
      },
      candidates: [
        { rule: 'sibling', target: sibling('-documentation'), hit: false },
        { rule: 'sibling', target: sibling('-docs'), hit: false },
        ...NO_GH_HIT(REPO),
        { rule: 'in_repo', target: join(root, 'docs'), hit: true },
      ],
    });
    expectConfined(accesses, execPaths, root, join(root, 'docs'));
  });

  it('none: nothing anywhere', async () => {
    const { root, sibling } = await project({ 'unrelated/README.md': 'x' });

    const { docs, warnings, accesses, execPaths } = await detect(root);

    expect(docs).toEqual({
      kind: 'none',
      localPath: null,
      repo: null,
      isGitRepo: false,
      detectedBy: null,
      evidence: [],
      classified: { specs: [], adr: [], roadmap: [], reports: [] },
      candidates: [
        { rule: 'sibling', target: sibling('-documentation'), hit: false },
        { rule: 'sibling', target: sibling('-docs'), hit: false },
        ...NO_GH_HIT(REPO),
        { rule: 'in_repo', target: join(root, 'docs'), hit: false },
      ],
    });
    expect(warnings.join('\n')).toContain('No documentation source found');
    expectConfined(accesses, execPaths, root, null);
  });

  it('skips rule 3 for a project that is not on GitHub', async () => {
    const { root } = await project();
    const { docs } = await detect(root, { repo: null });
    expect(docs.candidates.map((c) => c.rule)).not.toContain(
      'same_owner_remote',
    );
  });
});

describe('docs classification (D7)', () => {
  it('matches *adr* by name and ignores dot entries', async () => {
    ws = workspace();
    ws.files({
      'd/architecture-decision-records/': '',
      'd/ADR-index.md': '',
      'd/.adr-cache/': '',
      'd/prs/': '',
    });
    expect(classifyDocs(nodeFs, join(ws.ws, 'd'))).toEqual({
      specs: ['prs'],
      adr: ['ADR-index.md'],
      roadmap: [],
      reports: [],
    });
  });
});
