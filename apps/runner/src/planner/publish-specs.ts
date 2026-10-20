import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type {
  PlanPublishSpecsArgs,
  PlanPublishSpecsResult,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import { resolveFleetProject } from '../fleet/project';
import {
  GH_TIMEOUT_MS,
  gitOk,
  NETWORK_TIMEOUT_MS,
  parsePrUrl,
  randomShortId,
  type SkillsDeps,
  stderrLine,
} from '../skills/deps';

/** The docs worktree, beside the main checkout like every runner worktree. */
const docsWorktreePath = (root: string, shortId: string): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(
    dirname(trimmed),
    `.wt-${basename(trimmed)}-plan-docs-${shortId}`,
  );
};

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);

/**
 * Writes `files` into `worktree`, each under `specDir`. The schema already
 * refuses `..` and absolute paths; this refuses a path that resolves through
 * a symlink out of `specDir`, and a symlink in the file's own place.
 */
const writeSpecFiles = (
  worktree: string,
  specDir: string,
  files: PlanPublishSpecsArgs['files'],
): void => {
  const top = realpathSync(worktree);
  for (const file of files) {
    const target = join(worktree, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const specRoot = realpathSync(join(worktree, specDir));
    if (
      !inside(specRoot, top) ||
      !inside(realpathSync(dirname(target)), specRoot)
    ) {
      throw new CommandFailure(
        'path_not_allowed',
        `${file.path} resolves outside ${specDir}`,
      );
    }
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(target);
    } catch {
      existing = undefined;
    }
    if (existing && !existing.isFile()) {
      throw new CommandFailure(
        'path_not_allowed',
        `${file.path} exists and is not a regular file`,
      );
    }
    writeFileSync(target, file.content);
  }
};

/** An open pull request from `branch`, when a previous attempt already opened it. */
const openPr = async (
  deps: Pick<SkillsDeps, 'exec'>,
  github: string,
  branch: string,
): Promise<PlanPublishSpecsResult | null> => {
  const view = await deps.exec(
    'gh',
    ['pr', 'view', branch, '--repo', github, '--json', 'number,url,state'],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!view || view.code !== 0) return null;
  try {
    const pr = JSON.parse(view.stdout) as {
      number?: unknown;
      url?: unknown;
      state?: unknown;
    };
    return pr.state === 'OPEN' &&
      typeof pr.number === 'number' &&
      typeof pr.url === 'string'
      ? { prNumber: pr.number, prUrl: pr.url }
      : null;
  } catch {
    return null;
  }
};

/** Where a docs pull request is opened: a checkout, its GitHub repo and base. */
export interface SpecsPrTarget {
  /** The main checkout the docs worktree is added to. */
  root: string;
  /** `owner/name` on GitHub. */
  github: string;
  base: string;
}

/** What one docs pull request carries. */
export interface SpecsPrContent {
  specDir: string;
  branch: string;
  files: PlanPublishSpecsArgs['files'];
  title: string;
  body: string;
}

/**
 * One docs pull request into `target.base` with exactly `content.files`.
 * The commit is the runner's own: the checkout's hooks do not run and the
 * message is the title alone — no `Co-Authored-By`, no `Claude-Session`. A
 * retry after the PR was opened answers that PR. Shared by
 * `plan.publish_specs` (the code repository) and `docs.publish_specs` (an
 * external docs repository, #379).
 */
export const openSpecsPr = async (
  target: SpecsPrTarget,
  content: SpecsPrContent,
  deps: Pick<SkillsDeps, 'exec' | 'shortId' | 'tempRoot'>,
): Promise<PlanPublishSpecsResult> => {
  const { exec } = deps;
  const { root, github } = target;
  const existing = await openPr(deps, github, content.branch);
  if (existing) return existing;

  await gitOk(
    exec,
    ['-C', root, 'fetch', '--quiet', 'origin', target.base],
    NETWORK_TIMEOUT_MS,
  );
  const base = (
    await gitOk(exec, [
      '-C',
      root,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${target.base}^{commit}`,
    ])
  ).trim();
  const worktree = docsWorktreePath(root, (deps.shortId ?? randomShortId)());
  // `-B`: a local branch an earlier, failed attempt left is reset, not refused.
  await gitOk(exec, [
    '-C',
    root,
    'worktree',
    'add',
    '--quiet',
    '--no-track',
    '-B',
    content.branch,
    worktree,
    base,
  ]);
  const temp = await mkdtemp(join(deps.tempRoot ?? tmpdir(), 'nautelle-pr-'));
  try {
    writeSpecFiles(worktree, content.specDir, content.files);
    await gitOk(exec, [
      '-C',
      worktree,
      'add',
      '--',
      ...content.files.map((f) => f.path),
    ]);
    await gitOk(exec, [
      '-C',
      worktree,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      content.title,
    ]);
    // `--force`: the branch is this plan's or card's alone; an earlier attempt may have pushed it.
    await gitOk(
      exec,
      [
        '-C',
        worktree,
        'push',
        '--quiet',
        '--force',
        'origin',
        `HEAD:refs/heads/${content.branch}`,
      ],
      NETWORK_TIMEOUT_MS,
    );
    const bodyFile = join(temp, 'body.md');
    await writeFile(bodyFile, content.body, { mode: 0o600 });
    const created = await exec(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        github,
        '--base',
        target.base,
        '--head',
        content.branch,
        '--title',
        content.title,
        '--body-file',
        bodyFile,
      ],
      { timeoutMs: GH_TIMEOUT_MS },
    );
    if (!created || created.code !== 0) {
      throw new Error(`gh pr create failed: ${stderrLine(created)}`);
    }
    const pr = parsePrUrl(created.stdout);
    if (!pr) throw new Error('gh pr create printed no pull request URL');
    return { prNumber: pr.number, prUrl: pr.url };
  } finally {
    await rm(temp, { recursive: true, force: true });
    await exec('git', ['-C', root, 'worktree', 'remove', '--force', worktree]);
    // The pushed branch stays for its PR; the local one is not needed.
    await exec('git', ['-C', root, 'branch', '--quiet', '-D', content.branch]);
  }
};

/** `plan.publish_specs` (D10): one docs pull request into the project's `base`. */
export const publishSpecs = async (
  args: PlanPublishSpecsArgs,
  deps: SkillsDeps,
): Promise<PlanPublishSpecsResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const fleet = await resolveFleetProject(deps.exec, project);
  if (!fleet.github) {
    throw new CommandFailure(
      'not_a_repository',
      `${project.root} has no GitHub remote`,
    );
  }
  return openSpecsPr(
    { root: project.root, github: fleet.github, base: args.base },
    args,
    deps,
  );
};
