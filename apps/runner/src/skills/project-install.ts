import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  type SkillInstallArgs,
  type SkillInstallResult,
  type SkillProvenance,
  skillInstallBranch,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import { resolveFleetProject } from '../fleet/project';
import {
  GH_TIMEOUT_MS,
  gitOk,
  gitSucceeds,
  NETWORK_TIMEOUT_MS,
  NO_HOOKS,
  parsePrUrl,
  randomShortId,
  type SkillsDeps,
  stderrLine,
} from './deps';
import type { DiscoveredSkill } from './discover';
import { projectSkillsDir, writeSkillDir } from './layout';

type ProjectTarget = Extract<SkillInstallArgs['target'], { scope: 'project' }>;

export interface PreparedSkill {
  checkoutDir: string;
  skill: DiscoveredSkill;
  provenance: SkillProvenance;
}

/** D4: `<parent>/.wt-<repo>-skill-<shortid>`, beside the main checkout. */
export const installWorktreePath = (root: string, shortId: string): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(dirname(trimmed), `.wt-${basename(trimmed)}-skill-${shortId}`);
};

export const installPrBody = (
  args: SkillInstallArgs,
  prepared: PreparedSkill,
  installPath: string,
): string =>
  [
    `Installs the skill \`${args.skillId}\` into \`${installPath}/\`.`,
    '',
    `- **Source:** https://github.com/${args.source}`,
    `- **Commit:** \`${args.commit}\``,
    `- **contentHash:** \`${args.contentHash}\``,
    '',
    '| File | Size | SHA-256 |',
    '|---|---|---|',
    ...prepared.skill.files.map(
      (f) => `| \`${f.path}\` | ${f.size} | \`${f.sha256}\` |`,
    ),
    '',
    'Review every file before merging: a skill is instructions an agent follows.',
    '',
  ].join('\n');

/**
 * D4: a project install is a pull request. The skill is committed on
 * `skills/<name>` in a worktree of its own, from `origin/<base>`; the main
 * checkout's tree and HEAD are never touched. The worktree and local branch
 * are removed whatever happens; a pushed branch stays for its PR.
 */
export const installProjectSkill = async (
  args: SkillInstallArgs & { target: ProjectTarget },
  prepared: PreparedSkill,
  deps: SkillsDeps,
): Promise<SkillInstallResult> => {
  const { target } = args;
  const { exec } = deps;
  const project = watchedProject(target, deps.watchedProjects());
  const fleet = await resolveFleetProject(exec, project);
  if (!fleet.github) {
    throw new CommandFailure(
      'not_a_repository',
      `${project.root} has no GitHub remote`,
    );
  }
  const root = project.root;
  const branch = skillInstallBranch(args.skillId);
  const installPath = `${projectSkillsDir(target.runtime)}/${args.skillId}`;

  await gitOk(
    exec,
    ['-C', root, 'fetch', '--quiet', 'origin', target.base],
    NETWORK_TIMEOUT_MS,
  );
  const base = `origin/${target.base}`;
  if (
    await gitSucceeds(exec, [
      '-C',
      root,
      'cat-file',
      '-e',
      `${base}:${installPath}`,
    ])
  ) {
    throw new CommandFailure(
      'already_exists',
      `${installPath} already exists on ${base}`,
    );
  }
  if (
    await gitSucceeds(exec, [
      '-C',
      root,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ])
  ) {
    throw new CommandFailure(
      'already_exists',
      `branch ${branch} already exists`,
    );
  }
  const remote = await exec(
    'git',
    ['-C', root, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (!remote || remote.code !== 0) {
    throw new Error(`git ls-remote failed: ${stderrLine(remote)}`);
  }
  if (remote.stdout.trim().length > 0) {
    throw new CommandFailure('already_exists', `origin already has ${branch}`);
  }

  const worktree = installWorktreePath(root, (deps.shortId ?? randomShortId)());
  await gitOk(exec, [
    '-C',
    root,
    'worktree',
    'add',
    '--quiet',
    '--no-track',
    '-b',
    branch,
    worktree,
    base,
  ]);
  const bodyDir = await mkdtemp(
    join(deps.tempRoot ?? tmpdir(), 'agentdock-pr-'),
  );
  try {
    writeSkillDir(
      prepared.checkoutDir,
      prepared.skill,
      prepared.provenance,
      join(worktree, installPath),
    );
    await gitOk(exec, ['-C', worktree, 'add', '--', installPath]);
    await gitOk(exec, [
      '-C',
      worktree,
      ...NO_HOOKS,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      `feat(skills): install ${args.skillId} from ${args.source}`,
    ]);
    await gitOk(
      exec,
      [
        '-C',
        worktree,
        ...NO_HOOKS,
        'push',
        '--quiet',
        'origin',
        `HEAD:refs/heads/${branch}`,
      ],
      NETWORK_TIMEOUT_MS,
    );
    const bodyFile = join(bodyDir, 'body.md');
    await writeFile(bodyFile, installPrBody(args, prepared, installPath), {
      mode: 0o600,
    });
    const created = await exec(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        fleet.github,
        '--base',
        target.base,
        '--head',
        branch,
        '--title',
        `feat(skills): install ${args.skillId}`,
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
    return { path: installPath, prUrl: pr.url };
  } finally {
    await rm(bodyDir, { recursive: true, force: true });
    await exec('git', ['-C', root, 'worktree', 'remove', '--force', worktree]);
    await exec('git', ['-C', root, 'branch', '--quiet', '-D', branch]);
  }
};
