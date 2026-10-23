import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CardReviewComment,
  CardReviewPublishArgs,
  CardReviewPublishResult,
  WatchedProject,
} from '@nautelle/shared/protocol';
import { watchedProject } from '../control/target';
import type { Exec, ExecResult } from '../detect/exec';
import { redactUrlUserinfo } from '../redact-url';
import { githubOf } from '../skills/run/collect';
import { firstLine, ghOf } from './github';

export interface CardReviewPublishDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
  tempRoot?: string;
}

/** GitHub's own limit on a review body, in characters. */
export const GITHUB_REVIEW_BODY_MAX = 65_536;

/** GitHub refuses the review: an inline comment on a line outside the diff. */
const UNPROCESSABLE = /HTTP 422|Unprocessable Entity/i;

const message = (text: string): string =>
  redactUrlUserinfo((text.split('\n')[0] ?? '').slice(0, 500));

const TRUNCATED = '\n\n_(truncated)_';

/**
 * #884: the review's body with every inline comment folded in, under
 * GitHub's limit — what is posted when GitHub refuses the inline comments.
 */
export const foldedReviewBody = (
  body: string,
  comments: readonly CardReviewComment[],
): string => {
  const folded = [
    body,
    ...comments.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`),
  ].join('\n\n---\n\n');
  return folded.length <= GITHUB_REVIEW_BODY_MAX
    ? folded
    : folded.slice(0, GITHUB_REVIEW_BODY_MAX - TRUNCATED.length) + TRUNCATED;
};

interface ReviewPayload {
  commit_id: string;
  event: 'COMMENT';
  body: string;
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[];
}

/**
 * One `gh api --method POST …/reviews`, the JSON body in a private file
 * (0600, in a directory of its own) that is gone when the call returns.
 */
const postReview = async (
  deps: CardReviewPublishDeps,
  endpoint: string,
  payload: ReviewPayload,
): Promise<ExecResult | null> => {
  const dir = await mkdtemp(
    join(deps.tempRoot ?? tmpdir(), 'nautelle-review-'),
  );
  try {
    const file = join(dir, 'review.json');
    await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    return await ghOf(deps.exec)([
      'api',
      '--method',
      'POST',
      endpoint,
      '--input',
      file,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const refusedBy422 = (result: ExecResult | null): boolean =>
  result !== null &&
  result.code !== 0 &&
  UNPROCESSABLE.test(`${result.stderr}\n${result.stdout}`);

/**
 * #884 (ADR-0084 §6, ADR-0010): posts a review step's findings as one pull
 * request review (`event: COMMENT`) on `headSha` — `comments` inline on the
 * head side, `body` as the summary. GitHub answers 422 for an inline comment
 * on a line outside the diff; the review is then posted once more with every
 * comment folded into the body (`inline: false`). A refusal is a result,
 * never a thrown command error, except for a target that is not a watched
 * project.
 */
export const publishCardReview = async (
  args: CardReviewPublishArgs,
  deps: CardReviewPublishDeps,
): Promise<CardReviewPublishResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  let github: string;
  try {
    github = await githubOf(deps, project);
  } catch (error) {
    return {
      published: false,
      error: 'gh_failed',
      message: message(error instanceof Error ? error.message : String(error)),
    };
  }
  const endpoint = `repos/${github}/pulls/${args.prNumber}/reviews`;
  const inline = await postReview(deps, endpoint, {
    commit_id: args.headSha,
    event: 'COMMENT',
    body: args.body,
    comments: args.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: c.body,
    })),
  });
  if (inline?.code === 0) return { published: true, inline: true };
  if (args.comments.length === 0 || !refusedBy422(inline)) {
    return {
      published: false,
      error: 'gh_failed',
      message: message(firstLine(inline)),
    };
  }
  const folded = await postReview(deps, endpoint, {
    commit_id: args.headSha,
    event: 'COMMENT',
    body: foldedReviewBody(args.body, args.comments),
    comments: [],
  });
  if (folded?.code === 0) return { published: true, inline: false };
  return {
    published: false,
    error: 'gh_failed',
    message: message(firstLine(folded)),
  };
};
