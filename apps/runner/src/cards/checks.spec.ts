import { describe, expect, it } from 'bun:test';
import {
  CARD_CHECKS_MAX,
  type CardChecksArgs,
  cardChecksResultSchema,
  type WatchedProject,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ExecResult } from '../detect/exec';
import { cardChecks } from './checks';

/**
 * #359 D5: `card.checks` against a faked `gh` (and the `git remote` the
 * project's GitHub repository is read from). The `gh pr checks` outputs are
 * the shapes gh 2.98 prints, exit codes included.
 */

const HEAD = 'b'.repeat(40);

const project = { id: 'p1', root: '/home/me/widget' } as WatchedProject;

const args: CardChecksArgs = {
  cardId: 'card_1',
  projectId: 'p1',
  root: '/home/me/widget',
  pr: 41,
};

const ok = (stdout: unknown): ExecResult => ({
  code: 0,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr: '',
});

interface Fake {
  view?: ExecResult;
  checks?: ExecResult;
}

const setup = (fake: Fake) => {
  const gh: string[][] = [];
  const exec = async (
    binary: string,
    argv: readonly string[],
  ): Promise<ExecResult | null> => {
    if (binary === 'git') {
      return argv.includes('get-url')
        ? ok('git@github.com:acme/widget.git\n')
        : { code: 1, stdout: '', stderr: '' };
    }
    gh.push([...argv]);
    if (argv[1] === 'view') {
      return (
        fake.view ??
        ok({
          state: 'OPEN',
          isDraft: true,
          headRefOid: HEAD,
          mergeable: 'MERGEABLE',
          baseRefName: 'develop',
          mergedAt: null,
        })
      );
    }
    if (argv[1] === 'checks') return fake.checks ?? ok([]);
    return { code: 1, stdout: '', stderr: 'unsupported' };
  };
  const run = (a: CardChecksArgs = args) =>
    cardChecks(a, { exec, watchedProjects: () => [project] });
  return { gh, run };
};

const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CommandFailure ? error.code : String(error),
  );

describe('card.checks (#359 D5)', () => {
  it('reads the head and the checks with argument arrays, failing checks included', async () => {
    const t = setup({
      // `gh pr checks` exits 1 while a check fails, with the JSON on stdout.
      checks: {
        code: 1,
        stdout: JSON.stringify([
          {
            name: 'ci/woodpecker/pr/pipeline',
            bucket: 'fail',
            link: 'https://ci.example/repos/9/pipeline/678/1',
          },
          { name: 'lint', bucket: 'pass', link: '' },
        ]),
        stderr: '',
      },
    });
    const result = await t.run();
    expect(cardChecksResultSchema.parse(result)).toEqual({
      state: 'draft',
      headSha: HEAD,
      mergeable: 'MERGEABLE',
      base: 'develop',
      mergedAt: null,
      checks: [
        {
          name: 'ci/woodpecker/pr/pipeline',
          bucket: 'fail',
          link: 'https://ci.example/repos/9/pipeline/678/1',
        },
        { name: 'lint', bucket: 'pass', link: null },
      ],
    });
    expect(t.gh).toEqual([
      [
        'pr',
        'view',
        '41',
        '--repo',
        'acme/widget',
        '--json',
        'state,isDraft,headRefOid,mergeable,baseRefName,mergedAt',
      ],
      [
        'pr',
        'checks',
        '41',
        '--repo',
        'acme/widget',
        '--json',
        'name,bucket,link',
      ],
    ]);
  });

  it('a head without checks is checks: [] (gh exits 1 with "no checks reported")', async () => {
    const t = setup({
      checks: {
        code: 1,
        stdout: '',
        stderr: "no checks reported on the 'card/c12-export-csv' branch\n",
      },
    });
    expect((await t.run()).checks).toEqual([]);
  });

  it('pending checks exit 8 and still read; a CONFLICTING PR is reported', async () => {
    const t = setup({
      view: ok({
        state: 'OPEN',
        isDraft: false,
        headRefOid: HEAD,
        mergeable: 'CONFLICTING',
      }),
      checks: {
        code: 8,
        stdout: JSON.stringify([
          { name: 'build', bucket: 'pending', link: null },
        ]),
        stderr: '',
      },
    });
    expect(await t.run()).toMatchObject({
      state: 'open',
      mergeable: 'CONFLICTING',
      checks: [{ name: 'build', bucket: 'pending', link: null }],
    });
  });

  it('maps merged and closed PRs; an unknown mergeable is UNKNOWN', async () => {
    for (const [state, expected] of [
      ['MERGED', 'merged'],
      ['CLOSED', 'closed'],
    ] as const) {
      const t = setup({
        view: ok({ state, isDraft: false, headRefOid: HEAD, mergeable: '' }),
      });
      expect(await t.run()).toMatchObject({
        state: expected,
        mergeable: 'UNKNOWN',
      });
    }
  });

  it('reports the branch a merged PR went into and when it merged (#709)', async () => {
    const t = setup({
      view: ok({
        state: 'MERGED',
        isDraft: false,
        headRefOid: HEAD,
        mergeable: 'UNKNOWN',
        baseRefName: 'feat/1-the-dependency',
        mergedAt: '2026-10-20T09:30:00Z',
      }),
    });
    const result = await t.run();
    expect(cardChecksResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      state: 'merged',
      base: 'feat/1-the-dependency',
      mergedAt: '2026-10-20T09:30:00Z',
    });
  });

  it('drops rows the contract cannot carry, and keeps at most CARD_CHECKS_MAX', async () => {
    const rows = [
      { name: '', bucket: 'pass', link: null },
      { name: 'future', bucket: 'neutral', link: null },
      { name: 'plain-http', bucket: 'cancel', link: 'http://ci.example/1' },
      { name: 'x'.repeat(300), bucket: 'skipping', link: 'not a url' },
      ...Array.from({ length: CARD_CHECKS_MAX + 5 }, (_, i) => ({
        name: `c${i}`,
        bucket: 'pass',
        link: null,
      })),
    ];
    const t = setup({ checks: ok(rows) });
    const result = cardChecksResultSchema.parse(await t.run());
    expect(result.checks).toHaveLength(CARD_CHECKS_MAX);
    expect(result.checks[0]).toEqual({
      name: 'plain-http',
      bucket: 'cancel',
      link: null,
    });
    expect(result.checks[1]?.name).toHaveLength(200);
    expect(result.checks[1]?.link).toBeNull();
  });

  it('a gh that cannot answer is upstream_unavailable; an unknown PR is not_found; an unwatched root is refused', async () => {
    expect(
      await failure(
        setup({
          view: { code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' },
        }).run(),
      ),
    ).toBe('upstream_unavailable');
    expect(
      await failure(
        setup({
          view: {
            code: 1,
            stdout: '',
            stderr:
              'GraphQL: Could not resolve to a PullRequest with the number of 41.',
          },
        }).run(),
      ),
    ).toBe('not_found');
    expect(
      await failure(
        setup({
          checks: { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' },
        }).run(),
      ),
    ).toBe('upstream_unavailable');
    const t = setup({});
    expect(await failure(t.run({ ...args, root: '/elsewhere' }))).toBe(
      'path_not_allowed',
    );
    expect(t.gh).toEqual([]);
  });
});
