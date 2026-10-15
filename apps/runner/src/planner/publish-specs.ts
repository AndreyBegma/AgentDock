import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type {
  PlanPublishSpecsArgs,
  PlanPublishSpecsResult,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import { resolveFleetProject } from '../fleet/project';
import {
  GH_TIMEOUT_MS,
  gitOk,
  NETWORK_TIMEOUT_MS,
  NO_HOOKS,
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
  deps: SkillsDeps,
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

/**
 * `plan.publish_specs` (D10): one docs pull request into `base` with exactly
 * `files`. The commit is the runner's own: the project's hooks do not run and
 * the message is the title alone — no `Co-Authored-By`, no `Claude-Session`.
 * A retry after the PR was opened answers that PR (send is idempotent).
 */
export const publishSpecs = async (
  args: PlanPublishSpecsArgs,
  deps: SkillsDeps,
): Promise<PlanPublishSpecsResult> => {
  const { exec } = deps;
  const project = watchedProject(args, deps.watchedProjects());
  const fleet = await resolveFleetProject(exec, project);
  if (!fleet.github) {
    throw new CommandFailure(
      'not_a_repository',
      `${project.root} has no GitHub remote`,
    );
  }
  const github = fleet.github;
  const existing = await openPr(deps, github, args.branch);
  if (existing) return existing;

  await gitOk(
    exec,
    ['-C', project.root, 'fetch', '--quiet', 'origin', args.base],
    NETWORK_TIMEOUT_MS,
  );
  const base = (
    await gitOk(exec, [
      '-C',
      project.root,
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${args.base}^{commit}`,
    ])
  ).trim();
  const worktree = docsWorktreePath(
    project.root,
    (deps.shortId ?? randomShortId)(),
  );
  // `-B`: a local branch an earlier, failed attempt left is reset, not refused.
  await gitOk(exec, [
    '-C',
    project.root,
    'worktree',
    'add',
    '--quiet',
    '--no-track',
    '-B',
    args.branch,
    worktree,
    base,
  ]);
  const temp = await mkdtemp(join(deps.tempRoot ?? tmpdir(), 'agentdock-pr-'));
  try {
    writeSpecFiles(worktree, args.specDir, args.files);
    await gitOk(exec, [
      '-C',
      worktree,
      'add',
      '--',
      ...args.files.map((f) => f.path),
    ]);
    await gitOk(exec, [
      '-C',
      worktree,
      ...NO_HOOKS,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      args.title,
    ]);
    // `--force`: the branch is this plan's alone; an earlier attempt may have pushed it.
    await gitOk(
      exec,
      [
        '-C',
        worktree,
        ...NO_HOOKS,
        'push',
        '--quiet',
        '--force',
        'origin',
        `HEAD:refs/heads/${args.branch}`,
      ],
      NETWORK_TIMEOUT_MS,
    );
    const bodyFile = join(temp, 'body.md');
    await writeFile(bodyFile, args.body, { mode: 0o600 });
    const created = await exec(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        github,
        '--base',
        args.base,
        '--head',
        args.branch,
        '--title',
        args.title,
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
    await exec('git', [
      '-C',
      project.root,
      'worktree',
      'remove',
      '--force',
      worktree,
    ]);
    // The pushed branch stays for its PR; the local one is not needed.
    await exec('git', [
      '-C',
      project.root,
      'branch',
      '--quiet',
      '-D',
      args.branch,
    ]);
  }
};
