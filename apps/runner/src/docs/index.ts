import type {
  CommandArgs,
  CommandResult,
  DocsCommandName,
  DocsPrStateArgs,
  DocsPrStateResult,
  DocsPublishSpecsArgs,
  DocsPublishSpecsResult,
} from '@agentdock/shared/protocol';
import { openSpecsPr } from '../planner/publish-specs';
import { GH_TIMEOUT_MS, type SkillsDeps, stderrLine } from '../skills/deps';
import { docsBaseOf, docsRepoOf } from './repo';

/** `docs.publish_specs` and `docs.pr_state` (#379, ADR-0036). */
export type DocsHandlers = {
  [N in DocsCommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>> | CommandResult<N>;
};

type DocsDeps = Pick<
  SkillsDeps,
  'exec' | 'watchedProjects' | 'shortId' | 'tempRoot'
>;

/**
 * `docs.publish_specs`: one pull request into the docs repository's default
 * branch, written in a worktree of its clone — the clone's own checkout is
 * never touched.
 */
export const publishDocsSpecs = async (
  args: DocsPublishSpecsArgs,
  deps: DocsDeps,
): Promise<DocsPublishSpecsResult> => {
  const repo = await docsRepoOf(args, deps);
  const base = await docsBaseOf(deps.exec, repo);
  const pr = await openSpecsPr(
    { root: repo.root, github: repo.github, base },
    args,
    deps,
  );
  return { repo: repo.github, ...pr };
};

/** `docs.pr_state`: `gh pr view` of a docs pull request. */
export const docsPrState = async (
  args: DocsPrStateArgs,
  deps: DocsDeps,
): Promise<DocsPrStateResult> => {
  const repo = await docsRepoOf(args, deps);
  const view = await deps.exec(
    'gh',
    [
      'pr',
      'view',
      String(args.pr),
      '--repo',
      repo.github,
      '--json',
      'state',
      '--jq',
      '.state',
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!view || view.code !== 0) {
    throw new Error(`gh pr view failed: ${stderrLine(view)}`);
  }
  const state = view.stdout.trim();
  return {
    state:
      state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
  };
};

export const createDocsHandlers = (deps: DocsDeps): DocsHandlers => ({
  'docs.publish_specs': (args) => publishDocsSpecs(args, deps),
  'docs.pr_state': (args) => docsPrState(args, deps),
});
