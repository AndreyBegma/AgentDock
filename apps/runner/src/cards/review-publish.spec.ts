import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CardReviewPublishArgs,
  cardReviewPublishResultSchema,
  type WatchedProject,
} from '@nautelle/shared/protocol';
import type { ExecResult } from '../detect/exec';
import {
  foldedReviewBody,
  GITHUB_REVIEW_BODY_MAX,
  publishCardReview,
} from './review-publish';

/**
 * #884: `card.reviewPublish` against a faked `gh` (and the `git remote` the
 * project's GitHub repository is read from).
 */

const project = { id: 'p1', root: '/home/me/widget' } as WatchedProject;
const HEAD = 'c'.repeat(40);

const args: CardReviewPublishArgs = {
  cardId: 'card_2',
  projectId: 'p1',
  root: '/home/me/widget',
  prNumber: 91,
  headSha: HEAD,
  body: 'Peer review: 1 blocking, 1 nit.',
  comments: [
    { path: 'src/a.ts', line: 12, body: '**blocking** The guard is inverted.' },
    { path: 'src/b.ts', line: 3, body: '**nit** Rename it.' },
  ],
};

const ok = (stdout = '{}'): ExecResult => ({ code: 0, stdout, stderr: '' });

const fail = (stderr: string, stdout = ''): ExecResult => ({
  code: 1,
  stdout,
  stderr,
});

interface Posted {
  argv: string[];
  payload: Record<string, unknown>;
  mode: number;
  file: string;
}

const setup = (answers: ExecResult[], remote = true) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'review-publish-'));
  const posted: Posted[] = [];
  const exec = async (
    binary: string,
    argv: readonly string[],
  ): Promise<ExecResult | null> => {
    if (binary === 'git') {
      return argv.includes('get-url') && remote
        ? ok('git@github.com:acme/widget.git\n')
        : { code: 1, stdout: '', stderr: '' };
    }
    const file = argv[argv.indexOf('--input') + 1] ?? '';
    posted.push({
      argv: [...argv],
      payload: JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >,
      mode: statSync(file).mode & 0o777,
      file,
    });
    return answers.shift() ?? fail('unexpected call');
  };
  const run = (a: CardReviewPublishArgs = args) =>
    publishCardReview(a, {
      exec,
      watchedProjects: () => [project],
      tempRoot,
    });
  return { posted, run, tempRoot };
};

describe('card.reviewPublish (#884)', () => {
  it('posts one COMMENT review with inline comments on the head side', async () => {
    const t = setup([ok()]);
    const result = await t.run();
    expect(result).toEqual({ published: true, inline: true });
    expect(cardReviewPublishResultSchema.safeParse(result).success).toBe(true);
    expect(t.posted).toHaveLength(1);
    const [call] = t.posted;
    expect(call?.argv.slice(0, 4)).toEqual([
      'api',
      '--method',
      'POST',
      'repos/acme/widget/pulls/91/reviews',
    ]);
    expect(call?.argv[4]).toBe('--input');
    expect(call?.payload).toEqual({
      commit_id: HEAD,
      event: 'COMMENT',
      body: 'Peer review: 1 blocking, 1 nit.',
      comments: [
        {
          path: 'src/a.ts',
          line: 12,
          side: 'RIGHT',
          body: '**blocking** The guard is inverted.',
        },
        {
          path: 'src/b.ts',
          line: 3,
          side: 'RIGHT',
          body: '**nit** Rename it.',
        },
      ],
    });
    // The body goes through a private file, never argv, and is gone after.
    expect(call?.argv.join(' ')).not.toContain('inverted');
    expect(call?.mode).toBe(0o600);
    expect(existsSync(call?.file ?? '')).toBe(false);
    expect(readdirSync(t.tempRoot)).toEqual([]);
  });

  it('folds the comments into the body when GitHub refuses them (422)', async () => {
    const t = setup([
      fail(
        'gh: Validation Failed (HTTP 422)',
        '{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}',
      ),
      ok(),
    ]);
    expect(await t.run()).toEqual({ published: true, inline: false });
    expect(t.posted).toHaveLength(2);
    const retry = t.posted[1]?.payload;
    expect(retry?.comments).toEqual([]);
    expect(retry?.commit_id).toBe(HEAD);
    expect(retry?.body).toBe(foldedReviewBody(args.body, args.comments));
    expect(String(retry?.body)).toContain('**`src/a.ts:12`**');
    expect(String(retry?.body)).toContain('The guard is inverted.');
    expect(readdirSync(t.tempRoot)).toEqual([]);
  });

  it('does not retry a 422 without inline comments, nor another failure', async () => {
    const bodyOnly = setup([fail('gh: Validation Failed (HTTP 422)')]);
    expect(await bodyOnly.run({ ...args, comments: [] })).toEqual({
      published: false,
      error: 'gh_failed',
      message: 'gh: Validation Failed (HTTP 422)',
    });
    expect(bodyOnly.posted).toHaveLength(1);

    const gone = setup([fail('gh: Not Found (HTTP 404)')]);
    expect(await gone.run()).toMatchObject({
      published: false,
      error: 'gh_failed',
      message: 'gh: Not Found (HTTP 404)',
    });
    expect(gone.posted).toHaveLength(1);
  });

  it('answers gh_failed when the folded review is refused too', async () => {
    const t = setup([
      fail('gh: Validation Failed (HTTP 422)'),
      fail('gh: Validation Failed (HTTP 422)'),
    ]);
    expect(await t.run()).toMatchObject({
      published: false,
      error: 'gh_failed',
    });
    expect(t.posted).toHaveLength(2);
  });

  it('answers gh_failed for a project without a GitHub remote, redacted', async () => {
    const t = setup([], false);
    const result = await t.run();
    expect(result).toMatchObject({ published: false, error: 'gh_failed' });
    expect(t.posted).toHaveLength(0);
  });

  it('redacts credentials in what gh says', async () => {
    const t = setup([
      fail('fatal: https://user:s3cret@github.com/acme/widget refused'),
    ]);
    const result = await t.run();
    expect(result.published).toBe(false);
    expect(JSON.stringify(result)).not.toContain('s3cret');
  });

  it('keeps a folded body under GitHub’s limit', () => {
    const long = 'x'.repeat(10 * 1024);
    const folded = foldedReviewBody(
      'Summary',
      Array.from({ length: 50 }, (_, i) => ({
        path: `src/f${i}.ts`,
        line: i + 1,
        body: long,
      })),
    );
    expect(folded.length).toBe(GITHUB_REVIEW_BODY_MAX);
    expect(folded.endsWith('_(truncated)_')).toBe(true);
    expect(foldedReviewBody('Summary', [])).toBe('Summary');
  });
});
