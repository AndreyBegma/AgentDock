import {
  CARD_CHECKS_MAX,
  type CardCheck,
  type CardChecksArgs,
  type CardChecksResult,
  cardCheckBucketSchema,
  cardPrMergeableSchema,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import type { Exec } from '../detect/exec';
import { redactUrlUserinfo } from '../redact-url';
import { githubOf } from '../skills/run/collect';
import { firstLine, ghOf, parsed } from './github';

export interface CardChecksDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
}

const prViewSchema = z.looseObject({
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  mergeable: z.string(),
  baseRefName: z.string().min(1).max(255).optional(),
  mergedAt: z.iso.datetime({ offset: true }).nullish().catch(null),
});

const checkRowSchema = z.looseObject({
  name: z.string(),
  bucket: z.string(),
  link: z.string().nullish(),
});

/** `gh pr checks` of a PR whose head has no checks: exit 1 and this line. */
const NO_CHECKS = /no checks reported/i;

/** `gh pr view` of a number that is no PR of the repository. */
const NOT_A_PR = /Could not resolve to a PullRequest|no pull requests found/i;

const CHECK_NAME_MAX = 200;

const stateOf = (view: z.infer<typeof prViewSchema>) => {
  if (view.state === 'MERGED') return 'merged';
  if (view.state === 'CLOSED') return 'closed';
  return view.isDraft ? 'draft' : 'open';
};

const httpsLink = (link: string | null | undefined): string | null => {
  if (!link) return null;
  try {
    return new URL(link).protocol === 'https:' ? link : null;
  } catch {
    return null;
  }
};

/**
 * One row of `gh pr checks --json name,bucket,link`, or null for a row the
 * contract cannot carry (no name, a bucket `gh` added later).
 */
const checkOf = (row: z.infer<typeof checkRowSchema>): CardCheck | null => {
  const name = row.name.trim().slice(0, CHECK_NAME_MAX);
  const bucket = cardCheckBucketSchema.safeParse(row.bucket);
  if (!name || !bucket.success) return null;
  return { name, bucket: bucket.data, link: httpsLink(row.link) };
};

/**
 * #359 D5 (ADR-0010): a card PR's head and checks through `gh`, argument
 * arrays only — `gh pr view <pr> --json
 * state,isDraft,headRefOid,mergeable,baseRefName,mergedAt` (#709 reads the
 * base and the merge time)
 * and `gh pr checks <pr> --json name,bucket,link`. `gh pr checks` exits
 * non-zero while a check fails or runs, so its JSON is read whatever the exit
 * code; a head without checks is `checks: []`. CI logs are never read. A
 * `gh` that cannot answer is `upstream_unavailable`; a number that is no PR
 * of the repository, or a project without a GitHub remote, `not_found`.
 */
export const cardChecks = async (
  args: CardChecksArgs,
  deps: CardChecksDeps,
): Promise<CardChecksResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const gh = ghOf(deps.exec);
  const pr = String(args.pr);
  let github: string;
  try {
    github = await githubOf(deps, project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandFailure(
      'not_found',
      redactUrlUserinfo(message.split('\n')[0] ?? message),
    );
  }
  const viewed = await gh([
    'pr',
    'view',
    pr,
    '--repo',
    github,
    '--json',
    'state,isDraft,headRefOid,mergeable,baseRefName,mergedAt',
  ]);
  const view = viewed?.code === 0 ? parsed(prViewSchema, viewed.stdout) : null;
  if (!view) {
    throw new CommandFailure(
      NOT_A_PR.test(firstLine(viewed)) ? 'not_found' : 'upstream_unavailable',
      `gh pr view failed: ${firstLine(viewed)}`,
    );
  }
  const mergeable = cardPrMergeableSchema.safeParse(view.mergeable);

  const listed = await gh([
    'pr',
    'checks',
    pr,
    '--repo',
    github,
    '--json',
    'name,bucket,link',
  ]);
  const rows = listed ? parsed(z.array(checkRowSchema), listed.stdout) : null;
  let checks: CardCheck[];
  if (rows) {
    checks = rows
      .map(checkOf)
      .filter((c): c is CardCheck => c !== null)
      .slice(0, CARD_CHECKS_MAX);
  } else if (listed && NO_CHECKS.test(`${listed.stderr}\n${listed.stdout}`)) {
    checks = [];
  } else {
    throw new CommandFailure(
      'upstream_unavailable',
      `gh pr checks failed: ${firstLine(listed)}`,
    );
  }
  return {
    state: stateOf(view),
    headSha: view.headRefOid,
    mergeable: mergeable.success ? mergeable.data : 'UNKNOWN',
    checks,
    ...(view.baseRefName !== undefined ? { base: view.baseRefName } : {}),
    mergedAt: view.mergedAt ?? null,
  };
};
