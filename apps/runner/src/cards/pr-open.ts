import {
  type CardPrOpenArgs,
  type CardPrOpenResult,
  cardPrMergeableSchema,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { watchedProject } from '../control/target';
import type { Exec } from '../detect/exec';
import { redactUrlUserinfo } from '../redact-url';
import { createPullRequest, githubOf } from '../skills/run/collect';
import { firstLine, ghOf, parsed } from './github';

export interface CardPrOpenDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
  tempRoot?: string;
}

const listedSchema = z.array(
  z.looseObject({
    number: z.number().int().positive(),
    url: z.string().min(1),
  }),
);

const viewSchema = z.looseObject({ mergeable: z.string() });

/** GitHub refuses a PR whose head is no branch of the repository. */
const NO_BRANCH = /Head ref must be a branch|Head sha can't be blank/i;
/** GitHub refuses a PR whose head has nothing the base lacks. */
const NO_COMMITS = /No commits between/i;

const message = (text: string): string =>
  redactUrlUserinfo((text.split('\n')[0] ?? '').slice(0, 500));

/**
 * #709 (ADR-0064, ADR-0010): a PR of the pushed `branch` into `base` — an
 * open one is reused (`gh pr list --head --base --state open`), else `gh pr
 * create`, then `gh pr view --json mergeable`. Argument arrays only. A
 * refusal is a result, never a thrown command error, except for a target
 * that is not a watched project.
 */
export const openCardPr = async (
  args: CardPrOpenArgs,
  deps: CardPrOpenDeps,
): Promise<CardPrOpenResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const gh = ghOf(deps.exec);
  let github: string;
  try {
    github = await githubOf(deps, project);
  } catch (error) {
    return {
      opened: false,
      error: 'gh_failed',
      message: message(error instanceof Error ? error.message : String(error)),
    };
  }
  const listed = await gh([
    'pr',
    'list',
    '--repo',
    github,
    '--head',
    args.branch,
    '--base',
    args.base,
    '--state',
    'open',
    '--json',
    'number,url',
    '--limit',
    '1',
  ]);
  const rows =
    listed?.code === 0 ? parsed(listedSchema, listed.stdout || '[]') : null;
  if (!rows) {
    return { opened: false, error: 'gh_failed', message: firstLine(listed) };
  }
  let pr: { number: number; url: string };
  const existing = rows[0];
  if (existing) {
    pr = { number: existing.number, url: existing.url };
  } else {
    try {
      pr = await createPullRequest(deps, {
        github,
        base: args.base,
        branch: args.branch,
        title: args.title,
        body: args.body,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        opened: false,
        error: NO_BRANCH.test(text)
          ? 'no_branch'
          : NO_COMMITS.test(text)
            ? 'no_commits'
            : 'gh_failed',
        message: message(text),
      };
    }
  }
  const viewed = await gh([
    'pr',
    'view',
    String(pr.number),
    '--repo',
    github,
    '--json',
    'mergeable',
  ]);
  const view = viewed?.code === 0 ? parsed(viewSchema, viewed.stdout) : null;
  const mergeable = cardPrMergeableSchema.safeParse(view?.mergeable);
  return {
    opened: true,
    prNumber: pr.number,
    prUrl: pr.url,
    alreadyOpen: existing !== undefined,
    mergeable: mergeable.success ? mergeable.data : 'UNKNOWN',
  };
};
