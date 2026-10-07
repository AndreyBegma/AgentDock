import { basename, dirname, join } from 'node:path';
import type {
  BaseSource,
  ProjectInspection,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import { emptyClassified } from './classify';
import { detectDocs } from './docs';
import { isDirectory, isFile, nodeFs, type ProjectFs } from './fs';
import { parseRemote } from './remote';

export const CODE_SENTINEL_CONFIG = '.code-analyzer-config.json';
/** D4's last resort. */
export const DEFAULT_BASE_BRANCH = 'main';

export interface InspectDeps {
  exec: Exec;
  fs?: ProjectFs;
}

const git = async (
  exec: Exec,
  cwd: string,
  args: string[],
): Promise<string | null> => {
  const result = await exec('git', ['-C', cwd, ...args]);
  if (result === null) {
    throw new Error('git is not installed on this runner');
  }
  return result.code === 0 ? result.stdout.trim() : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** D5: the `orchestrator` block, or why the file could not be used. */
const readCodeSentinelConfig = (
  fs: ProjectFs,
  file: string,
): ProjectInspection['codeSentinelConfig'] => {
  const text = fs.readFile(file);
  if (text === null) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      error: `${CODE_SENTINEL_CONFIG} is not valid JSON: ${(error as Error).message}`,
    };
  }
  if (!isRecord(json)) {
    return { error: `${CODE_SENTINEL_CONFIG} is not a JSON object` };
  }
  if (json.orchestrator === undefined) return {};
  if (!isRecord(json.orchestrator)) {
    return { error: '`orchestrator` is not an object' };
  }
  return { orchestrator: json.orchestrator };
};

/** D4: config → `origin/HEAD` → `gh` → `main`. */
const resolveBase = async (
  exec: Exec,
  root: string,
  repo: string | null,
  orchestrator: Record<string, unknown> | undefined,
): Promise<{ baseBranch: string; baseSource: BaseSource }> => {
  const configured = orchestrator?.base;
  if (typeof configured === 'string' && configured.trim()) {
    return { baseBranch: configured.trim(), baseSource: 'config' };
  }
  const originHead = await git(exec, root, [
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead?.startsWith('origin/')) {
    return {
      baseBranch: originHead.slice('origin/'.length),
      baseSource: 'origin_head',
    };
  }
  if (repo) {
    const view = await exec('gh', [
      'repo',
      'view',
      repo,
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ]);
    const branch = view?.code === 0 ? view.stdout.trim() : '';
    if (branch) return { baseBranch: branch, baseSource: 'gh' };
  }
  return { baseBranch: DEFAULT_BASE_BRANCH, baseSource: 'default' };
};

/**
 * `project.inspect` (D2–D7, D10): any existing absolute directory inside a git
 * repository. A linked worktree or a subdirectory is reported with
 * `isMainCheckout: false` and `root` set to the main checkout, and its docs
 * are not detected.
 */
export const inspectProject = async (
  path: string,
  deps: InspectDeps,
): Promise<ProjectInspection> => {
  const { exec } = deps;
  const fs = deps.fs ?? nodeFs;
  if (!isDirectory(fs, path)) {
    throw new CommandFailure('path_not_found', `${path} is not a directory`);
  }
  const real = fs.realpath(path) ?? path;
  const revParse = await git(exec, real, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--show-toplevel',
  ]);
  const [gitCommonDir, toplevel] = revParse?.split('\n') ?? [];
  if (!gitCommonDir || !toplevel) {
    throw new CommandFailure(
      'not_a_repository',
      `${path} is not inside a git working tree`,
    );
  }
  // D2: the main checkout is the folder holding the common `.git`.
  const mainRoot =
    basename(gitCommonDir) === '.git' ? dirname(gitCommonDir) : toplevel;
  const isMainCheckout = real === toplevel && toplevel === mainRoot;
  const warnings: string[] = [];
  if (!isMainCheckout) {
    warnings.push(
      `${path} is not the main checkout; connect ${mainRoot} instead.`,
    );
  }

  const originUrl = await git(exec, toplevel, ['remote', 'get-url', 'origin']);
  const remote = originUrl
    ? { url: originUrl, ...parseRemote(originUrl) }
    : { url: null, forge: 'unsupported' as const, repo: null };
  if (!originUrl) {
    warnings.push('The repository has no `origin` remote.');
  } else if (remote.forge === 'unsupported') {
    warnings.push(
      `origin ${originUrl} is not on GitHub; only GitHub projects can be connected.`,
    );
  }

  const configFile = join(toplevel, CODE_SENTINEL_CONFIG);
  const codeSentinelConfig = readCodeSentinelConfig(fs, configFile);
  if (codeSentinelConfig.error) warnings.push(codeSentinelConfig.error);
  const orchestrator = codeSentinelConfig.orchestrator;

  const base = await resolveBase(exec, toplevel, remote.repo, orchestrator);

  const specDir = orchestrator?.specDir;
  const detected = isMainCheckout
    ? await detectDocs({
        root: toplevel,
        repo: remote.repo,
        specDir: typeof specDir === 'string' ? specDir : undefined,
        configFile,
        fs,
        exec,
      })
    : null;

  return {
    root: mainRoot,
    gitCommonDir,
    isMainCheckout,
    remote,
    ...base,
    codeSentinelConfig,
    hasClaudeMd: isFile(fs, join(toplevel, 'CLAUDE.md')),
    hasAgentsMd: isFile(fs, join(toplevel, 'AGENTS.md')),
    docs: detected?.docs ?? {
      kind: 'none',
      localPath: null,
      repo: null,
      isGitRepo: false,
      detectedBy: null,
      evidence: [],
      classified: emptyClassified(),
      candidates: [],
    },
    warnings: [...warnings, ...(detected?.warnings ?? [])],
  };
};

/**
 * `project.refresh` (D9, D10): re-inspects a root only when the server's
 * watch list registers that root under that project id.
 */
export const refreshProject = async (
  args: { projectId: string; root: string },
  watched: readonly WatchedProject[],
  deps: InspectDeps,
): Promise<ProjectInspection> => {
  const registered = watched.some(
    (p) => p.id === args.projectId && p.root === args.root,
  );
  if (!registered) {
    throw new CommandFailure(
      'path_not_allowed',
      `${args.root} is not a registered root of project ${args.projectId}`,
    );
  }
  return inspectProject(args.root, deps);
};
