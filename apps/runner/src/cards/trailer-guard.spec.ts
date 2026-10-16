import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { cardDraftPullRequest, cardPullRequestBody } from '@agentdock/shared';
import type { CardCollectArgs } from '@agentdock/shared/protocol';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { collectCard, ensureWorktree } from './git';
import { cardWorktreePath } from './launch';
import { pushCardHead } from './push';
import type { CardRecord } from './record';
import { cardsWorkspace } from './testing';
import {
  commitsWithTrailer,
  heldDetail,
  TrailerHeld,
  trailerMessage,
} from './trailer-guard';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * #447 D7: the trailer guard against real git and a bare origin (`gh`
 * faked): a card commit with a Claude attribution trailer is never pushed,
 * the worker gets the list, and after the rewrite the push goes through.
 */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const BRANCH = 'card/c12-export-csv';
const TRAILED = [
  'feat: export the report as CSV',
  '',
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
].join('\n');

const setup = async () => {
  const f = await cardsWorkspace();
  teardown.push(f.cleanup);
  const record: CardRecord = {
    cardId: 'card_1',
    projectId: f.project.id,
    root: f.root,
    repo: 'widget',
    shortId: 'ab12cd34',
    worktree: cardWorktreePath(f.root, 'ab12cd34'),
    branch: BRANCH,
    base: 'main',
    tmuxSession: 'agentdock-card-ab12cd34',
    runId: 'run_1',
    phase: 'running',
    startedAt: '2026-10-16T12:00:00.000Z',
    pullRequest: cardDraftPullRequest({
      number: 12,
      title: 'Export the report as CSV',
      issueNumber: null,
    }),
  };
  const deps = { exec: f.exec, tempRoot: f.ws };
  await ensureWorktree(deps, record);
  const commit = async (file: string, message: string) => {
    f.write(record.worktree, { [file]: `${file}\n` });
    await f.run(record.worktree, 'add', '-A');
    await f.run(record.worktree, 'commit', '-q', '-m', message);
    return f.run(record.worktree, 'rev-parse', 'HEAD');
  };
  const originHead = () =>
    f
      .run(f.origin, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`)
      .catch(() => null);
  const collectArgs: CardCollectArgs = {
    cardId: record.cardId,
    projectId: record.projectId,
    root: f.root,
    base: 'main',
    branch: BRANCH,
    number: 12,
    title: 'C-12: Export the report as CSV',
    body: cardPullRequestBody({
      number: 12,
      summary: 'Added the CSV export.',
      issueNumber: null,
    }),
  };
  const heldShas = async () =>
    (await commitsWithTrailer(deps, record.worktree, BRANCH, 'main')).map(
      (c) => c.sha,
    );
  return { f, record, deps, commit, originHead, collectArgs, heldShas };
};

describe('trailer guard on the draft push (#447 D7)', () => {
  it('holds a commit with Co-Authored-By: Claude, names it, and pushes once it is rewritten', async () => {
    const t = await setup();
    await t.commit('src/a.ts', 'feat: a clean commit');
    const trailed = await t.commit('src/csv.ts', TRAILED);

    const held = await pushCardHead(t.deps, t.record, { trailerGuard: true });
    expect(held).toEqual({
      headSha: trailed,
      pushed: false,
      pr: null,
      held: [{ sha: trailed, subject: 'feat: export the report as CSV' }],
    });
    expect(await t.originHead()).toBeNull();
    expect(t.f.gh.calls).toEqual([]);

    // What the worker is told: the commit and what to do, in one line.
    const message = trailerMessage(held?.held ?? []);
    expect(message).toContain(trailed.slice(0, 12));
    expect(message).toContain('"feat: export the report as CSV"');
    expect(message).toContain('do not push');
    expect(message).not.toContain('\n');
    expect(heldDetail(held?.held ?? [])).toBe('1 commit to rewrite');

    // The worker rewrites the message; the next step pushes.
    await t.f.run(
      t.record.worktree,
      'commit',
      '-q',
      '--amend',
      '-m',
      'feat: export the report as CSV',
    );
    const step = await pushCardHead(t.deps, t.record, { trailerGuard: true });
    expect(step?.pushed).toBe(true);
    expect(step?.held).toBeUndefined();
    expect(await t.originHead()).toBe(
      await t.f.run(t.record.worktree, 'rev-parse', 'HEAD'),
    );
  });

  it('matches Claude-Session: and the Generated with Claude Code footer too', async () => {
    const t = await setup();
    const session = await t.commit(
      'src/a.ts',
      'fix: a\n\nClaude-Session: https://claude.ai/code/session_01',
    );
    const footer = await t.commit(
      'src/b.ts',
      'fix: b\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    );
    await t.commit(
      'src/c.ts',
      'fix: c\n\nCo-Authored-By: Ada <ada@example.com>',
    );
    expect(await t.heldShas()).toEqual([session, footer]);
  });

  it('only commits not yet on origin count', async () => {
    const t = await setup();
    await t.commit('src/a.ts', 'feat: a');
    await pushCardHead(t.deps, t.record, { trailerGuard: true });
    await t.f.run(t.record.worktree, 'fetch', '-q', 'origin');
    expect(
      await commitsWithTrailer(t.deps, t.record.worktree, BRANCH, 'main'),
    ).toEqual([]);
    const trailed = await t.commit('src/b.ts', TRAILED);
    expect(await t.heldShas()).toEqual([trailed]);
  });

  it('with the guard off, the push is as before', async () => {
    const t = await setup();
    await t.commit('src/csv.ts', TRAILED);
    const step = await pushCardHead(t.deps, t.record);
    expect(step?.pushed).toBe(true);
    expect(await t.originHead()).not.toBeNull();
  });
});

describe('trailer guard on card.collect (#447 D7)', () => {
  it('pushes nothing and opens no PR while a commit carries a trailer', async () => {
    const t = await setup();
    const trailed = await t.commit('src/csv.ts', TRAILED);
    let thrown: unknown;
    try {
      await collectCard(t.deps, t.record, t.collectArgs, {
        trailerGuard: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TrailerHeld);
    const held = thrown as TrailerHeld;
    expect(held.code).toBe('invalid_args');
    expect(held.commits.map((c) => c.sha)).toEqual([trailed]);
    expect(held.message).toContain('1 commit to rewrite');
    expect(await t.originHead()).toBeNull();
    expect(t.f.prCreates()).toEqual([]);
  });
});
