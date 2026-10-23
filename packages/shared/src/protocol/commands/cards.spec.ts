import { describe, expect, it } from 'bun:test';
import { commandErrorCodeSchema } from '../commands';
import { localMethods, parseLocalRequest } from '../local';
import {
  CARD_MERGE_COMMENT_MAX_BYTES,
  CARD_PR_CLOSE_COMMENT_MAX_BYTES,
  CARD_RUN_FILE_MAX_BYTES,
  CARD_RUN_FILES_MAX,
  CARD_RUN_PROMPT_MAX_BYTES,
  CARD_TIMEOUTS_MS,
  cardCloseArgsSchema,
  cardCollectArgsSchema,
  cardCollectResultSchema,
  cardCommands,
  cardMergeArgsSchema,
  cardMergeResultSchema,
  cardPrCloseArgsSchema,
  cardPrCloseCommands,
  cardPrCloseResultSchema,
  cardRunArgsSchema,
  cardRunResultSchema,
  cardSessionName,
  cardShortIdSchema,
  cardStopArgsSchema,
} from './cards';
import { terminalAttachArgsSchema, terminalTargetSchema } from './terminal';

const runArgs = {
  cardId: 'cm1card0000000000000000001',
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  root: '/home/me/app',
  base: 'develop',
  shortId: 'ab12cd34',
  branch: 'card/c12-add-login',
  session: { id: '0b7c6a52-3a4f-4e0e-9a2c-5c1e2f3a4b5c', resume: false },
  prompt: 'You are the dedicated worker for Nautelle board card C-12.',
  profileKey: 'claude-main',
  model: 'opus',
  permissionMode: 'acceptEdits',
};

describe('card.run args', () => {
  it('accepts a round 1 with a spec file', () => {
    const parsed = cardRunArgsSchema.safeParse({
      ...runArgs,
      files: [{ path: 'docs/specs/card-12-add-login.md', content: '# Spec' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a resumed round without files', () => {
    expect(
      cardRunArgsSchema.safeParse({
        ...runArgs,
        session: { ...runArgs.session, resume: true },
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown field — no command, no session name, no worktree', () => {
    for (const extra of [
      { command: 'rm -rf /' },
      { tmuxSession: 'cs-i1' },
      { worktree: '/tmp/x' },
    ]) {
      expect(
        cardRunArgsSchema.safeParse({ ...runArgs, ...extra }).success,
      ).toBe(false);
    }
  });

  it('refuses a session id that is not a uuid', () => {
    expect(
      cardRunArgsSchema.safeParse({
        ...runArgs,
        session: { id: 'abc', resume: false },
      }).success,
    ).toBe(false);
  });

  it('refuses a shortId that would not name an agentdock-card session', () => {
    for (const shortId of ['AB12CD34', 'ab12', 'ab12cd34e', '../x1234']) {
      expect(cardRunArgsSchema.safeParse({ ...runArgs, shortId }).success).toBe(
        false,
      );
    }
  });

  it('refuses a branch or model that reads as a flag or escapes a ref', () => {
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, branch: '-x' }).success,
    ).toBe(false);
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, branch: 'card/../main' })
        .success,
    ).toBe(false);
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, model: '--dangerously' })
        .success,
    ).toBe(false);
  });

  // C-148 (L-31): a card branch may not name the default branch.
  it('refuses a branch without a card prefix', () => {
    for (const branch of [
      'main',
      'master',
      'trunk',
      'develop',
      'card/',
      'release/1.0',
      'cards/x',
    ]) {
      expect(cardRunArgsSchema.safeParse({ ...runArgs, branch }).success).toBe(
        false,
      );
    }
    for (const branch of [
      'card/c12-add-login',
      'feat/34-login',
      'fix/34-login',
    ]) {
      expect(cardRunArgsSchema.safeParse({ ...runArgs, branch }).success).toBe(
        true,
      );
    }
  });

  it('bounds the prompt in bytes and refuses NUL', () => {
    expect(
      cardRunArgsSchema.safeParse({
        ...runArgs,
        prompt: 'x'.repeat(CARD_RUN_PROMPT_MAX_BYTES),
      }).success,
    ).toBe(true);
    expect(
      cardRunArgsSchema.safeParse({
        ...runArgs,
        prompt: '語'.repeat(CARD_RUN_PROMPT_MAX_BYTES / 3 + 1),
      }).success,
    ).toBe(false);
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, prompt: 'a\u0000b' }).success,
    ).toBe(false);
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, prompt: '' }).success,
    ).toBe(false);
  });

  it('takes a spec and every design frame (#441) as repository-relative files of bounded size', () => {
    const file = (path: string, content = '') => ({ path, content });
    const parse = (files: unknown) =>
      cardRunArgsSchema.safeParse({ ...runArgs, files }).success;
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => file(`design/1/f${i}.html`));
    expect(parse(many(CARD_RUN_FILES_MAX))).toBe(true);
    expect(parse(many(CARD_RUN_FILES_MAX + 1))).toBe(false);
    expect(parse([file('/etc/passwd')])).toBe(false);
    expect(parse([file('docs/../../x.md')])).toBe(false);
    expect(parse([file('a.md'), file('a.md')])).toBe(false);
    expect(parse([file('a.md', 'x'.repeat(CARD_RUN_FILE_MAX_BYTES))])).toBe(
      true,
    );
    expect(parse([file('a.md', 'x'.repeat(CARD_RUN_FILE_MAX_BYTES + 1))])).toBe(
      false,
    );
  });

  it('refuses a relative root', () => {
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, root: 'app' }).success,
    ).toBe(false);
  });

  it('answers with the card session', () => {
    expect(
      cardRunResultSchema.safeParse({
        phase: 'starting',
        tmuxSession: 'nautelle-card-ab12cd34',
      }).success,
    ).toBe(true);
    expect(
      cardRunResultSchema.safeParse({
        phase: 'starting',
        tmuxSession: 'cs-i12',
      }).success,
    ).toBe(false);
  });
});

describe('card.run startBranch (#854)', () => {
  it('a command without it is what an older runner already takes', () => {
    const parsed = cardRunArgsSchema.safeParse(runArgs);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('startBranch');
  });

  it('accepts a card branch other than branch', () => {
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, startBranch: 'feat/12-login' })
        .success,
    ).toBe(true);
  });

  it('refuses the card branch itself, a non-card branch and a follow-up', () => {
    for (const extra of [
      { startBranch: runArgs.branch },
      { startBranch: 'main' },
      { startBranch: 'chore/login' },
      {
        startBranch: 'feat/12-login',
        newBranch: true,
        session: { ...runArgs.session, resume: true },
      },
    ]) {
      expect(
        cardRunArgsSchema.safeParse({ ...runArgs, ...extra }).success,
      ).toBe(false);
    }
  });

  it('the result names the branch taken, or why not', () => {
    const base = { phase: 'running', tmuxSession: 'nautelle-card-ab12cd34' };
    expect(cardRunResultSchema.safeParse(base).success).toBe(true);
    expect(
      cardRunResultSchema.safeParse({ ...base, branch: 'feat/12-login' })
        .success,
    ).toBe(true);
    expect(
      cardRunResultSchema.safeParse({
        ...base,
        branch: runArgs.branch,
        startBranchSkipped: 'not_on_origin',
      }).success,
    ).toBe(true);
    expect(
      cardRunResultSchema.safeParse({ ...base, startBranchSkipped: 'nope' })
        .success,
    ).toBe(false);
  });
});

describe('card.run attachments (#309 D9)', () => {
  const ref = (id: string) => ({
    id,
    name: `${id} shot.png`,
    mime: 'image/png',
    size: 2048,
    sha256: 'f'.repeat(64),
  });

  it('lists the attachments by id, name, type, size and SHA-256', () => {
    const parsed = cardRunArgsSchema.safeParse({
      ...runArgs,
      attachments: [ref('a1'), ref('a2')],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.attachments?.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('takes an absent list and an empty one', () => {
    expect(cardRunArgsSchema.safeParse(runArgs).success).toBe(true);
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, attachments: [] }).success,
    ).toBe(true);
  });

  it('refuses more than 20, a repeated id, and an id that is a path', () => {
    const many = Array.from({ length: 21 }, (_, i) => ref(`a${i}`));
    for (const attachments of [
      many,
      [ref('a1'), ref('a1')],
      [ref('../a1')],
      [{ ...ref('a1'), path: '/etc/passwd' }],
    ]) {
      expect(
        cardRunArgsSchema.safeParse({ ...runArgs, attachments }).success,
      ).toBe(false);
    }
  });

  it('fails the run with attachments_unavailable', () => {
    expect(
      commandErrorCodeSchema.safeParse('attachments_unavailable').success,
    ).toBe(true);
  });
});

describe('card.stop, card.collect, card.close', () => {
  const target = { cardId: runArgs.cardId, projectId: 'p1' };

  it('stop takes only the card and project', () => {
    expect(cardStopArgsSchema.safeParse(target).success).toBe(true);
    expect(
      cardStopArgsSchema.safeParse({ ...target, session: 'x' }).success,
    ).toBe(false);
  });

  it('collect needs the branch, number and a one-line title', () => {
    const args = {
      ...target,
      root: '/home/me/app',
      base: 'develop',
      branch: 'card/c12-add-login',
      number: 12,
      title: 'Add login',
      body: 'Summary\n\nAgentDock-Card: C-12',
    };
    expect(cardCollectArgsSchema.safeParse(args).success).toBe(true);
    expect(
      cardCollectArgsSchema.safeParse({ ...args, title: 'a\nb' }).success,
    ).toBe(false);
    expect(
      cardCollectArgsSchema.safeParse({ ...args, number: 0 }).success,
    ).toBe(false);
    // C-148: a worktree collect pushes a card branch only.
    const unprefixed = cardCollectArgsSchema.safeParse({
      ...args,
      branch: 'main',
    });
    expect(unprefixed.success).toBe(false);
    expect(unprefixed.error?.issues[0]?.path).toEqual(['branch']);
  });

  it('collect of a terminal session keeps its own branch name (C-148)', () => {
    expect(
      cardCollectArgsSchema.safeParse({
        ...target,
        root: '/home/me/app',
        base: 'develop',
        branch: 'my-work',
        cwd: '/home/me/app',
        number: 12,
        title: 'Mine',
        body: '',
      }).success,
    ).toBe(true);
  });

  it('collect reports the protected paths it pushed (C-148)', () => {
    const parsed = cardCollectResultSchema.safeParse({
      ahead: 1,
      pushed: true,
      protectedPaths: ['.woodpecker/pipeline.yml'],
    });
    expect(parsed.data?.protectedPaths).toEqual(['.woodpecker/pipeline.yml']);
  });

  it('collect takes a terminal session cwd (#282 D3): absolute only, never on the base', () => {
    const args = {
      ...target,
      root: '/home/me/app',
      base: 'develop',
      branch: 'fix/12-pairing',
      cwd: '/home/me/app/packages/web',
      number: 12,
      title: 'Fix the pairing flake',
      body: '',
    };
    const parsed = cardCollectArgsSchema.safeParse(args);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.cwd).toBe('/home/me/app/packages/web');
    expect(
      cardCollectArgsSchema.safeParse({ ...args, cwd: 'packages/web' }).success,
    ).toBe(false);
    expect(cardCollectArgsSchema.safeParse({ ...args, cwd: '' }).success).toBe(
      false,
    );
    const onBase = cardCollectArgsSchema.safeParse({
      ...args,
      branch: 'develop',
    });
    expect(onBase.success).toBe(false);
    expect(onBase.error?.issues[0]?.path).toEqual(['branch']);
  });

  it('collect reports a PR as number and URL together', () => {
    expect(
      cardCollectResultSchema.safeParse({ ahead: 0, pushed: false }).success,
    ).toBe(true);
    expect(
      cardCollectResultSchema.safeParse({
        ahead: 2,
        pushed: true,
        prNumber: 7,
        prUrl: 'https://github.com/o/r/pull/7',
      }).success,
    ).toBe(true);
    expect(
      cardCollectResultSchema.safeParse({ ahead: 2, pushed: true, prNumber: 7 })
        .success,
    ).toBe(false);
  });

  it('close says whether to remove the worktree', () => {
    expect(
      cardCloseArgsSchema.safeParse({ ...target, removeWorktree: true })
        .success,
    ).toBe(true);
    expect(cardCloseArgsSchema.safeParse(target).success).toBe(false);
  });
});

describe('card.merge (#273 D11, D13)', () => {
  const mergeArgs = {
    cardId: runArgs.cardId,
    projectId: 'p1',
    root: '/home/me/app',
    pr: 41,
    headSha: 'a'.repeat(40),
    method: 'squash',
    issue: 12,
    comment: 'Completed as C-12 on the Nautelle board; merged in #41.',
  };

  it('accepts a merge, with or without a method and an issue', () => {
    expect(cardMergeArgsSchema.safeParse(mergeArgs).success).toBe(true);
    expect(
      cardMergeArgsSchema.safeParse({ ...mergeArgs, method: null, issue: null })
        .success,
    ).toBe(true);
  });

  it('rejects an extra key — no command text, no branch to name', () => {
    for (const extra of [
      { command: 'gh pr merge 41 --admin' },
      { branch: 'main' },
      { args: ['--admin'] },
      { deleteBranch: 'yes' },
    ]) {
      expect(
        cardMergeArgsSchema.safeParse({ ...mergeArgs, ...extra }).success,
      ).toBe(false);
    }
  });

  it('rejects a headSha that is not 40 lower-case hex', () => {
    for (const headSha of [
      'a'.repeat(39),
      'A'.repeat(40),
      'g'.repeat(40),
      'abc1234',
      `${'a'.repeat(40)}\n`,
    ]) {
      expect(
        cardMergeArgsSchema.safeParse({ ...mergeArgs, headSha }).success,
      ).toBe(false);
    }
  });

  it('rejects a relative root, an unknown method and an oversized comment', () => {
    for (const bad of [
      { root: 'app' },
      { root: '../app' },
      { method: 'fast-forward' },
      { comment: '' },
      { comment: 'x'.repeat(CARD_MERGE_COMMENT_MAX_BYTES + 1) },
    ]) {
      expect(
        cardMergeArgsSchema.safeParse({ ...mergeArgs, ...bad }).success,
      ).toBe(false);
    }
  });

  it('a result is a merge or a refusal with its reason', () => {
    expect(
      cardMergeResultSchema.safeParse({
        merged: true,
        alreadyMerged: false,
        method: 'squash',
        mergeCommit: 'b'.repeat(40),
        issueClosed: false,
        issueError: 'gh issue close failed',
      }).success,
    ).toBe(true);
    expect(
      cardMergeResultSchema.safeParse({
        merged: false,
        error: 'head_changed',
        message: 'the head moved',
      }).success,
    ).toBe(true);
    expect(
      cardMergeResultSchema.safeParse({
        merged: false,
        error: 'nope',
        message: 'x',
      }).success,
    ).toBe(false);
  });

  it('#329 D7: deleteBranch is optional, and branchDeleted reads as false when absent', () => {
    expect(
      cardMergeArgsSchema.safeParse({ ...mergeArgs, deleteBranch: true })
        .success,
    ).toBe(true);
    expect(cardMergeArgsSchema.parse(mergeArgs).deleteBranch).toBeUndefined();
    const older = {
      merged: true,
      alreadyMerged: false,
      method: 'squash',
      mergeCommit: 'b'.repeat(40),
      issueClosed: true,
    };
    expect(cardMergeResultSchema.parse(older)).toEqual({
      ...older,
      merged: true,
      method: 'squash',
      branchDeleted: false,
    });
    expect(
      cardMergeResultSchema.parse({
        ...older,
        branchDeleted: false,
        branchError: 'HTTP 422: Reference does not exist',
      }),
    ).toMatchObject({ branchDeleted: false, branchError: expect.any(String) });
    expect(
      cardMergeResultSchema.safeParse({
        ...older,
        branchError: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe('card.collect result (#329 D3, D6)', () => {
  const pr = { prNumber: 41, prUrl: 'https://github.com/o/r/pull/41' };

  it('carries an open PR with its state, also one it did not open', () => {
    expect(
      cardCollectResultSchema.safeParse({
        ahead: 3,
        pushed: false,
        ...pr,
        prState: 'draft',
      }).success,
    ).toBe(true);
    expect(
      cardCollectResultSchema.safeParse({ ahead: 3, pushed: true, ...pr })
        .success,
    ).toBe(true);
  });

  it('refuses a state without a PR, or a state a collect cannot see', () => {
    expect(
      cardCollectResultSchema.safeParse({
        ahead: 0,
        pushed: false,
        prState: 'open',
      }).success,
    ).toBe(false);
    for (const prState of ['merged', 'closed']) {
      expect(
        cardCollectResultSchema.safeParse({
          ahead: 1,
          pushed: true,
          ...pr,
          prState,
        }).success,
      ).toBe(false);
    }
  });
});

describe('card.prClose (#329 D8)', () => {
  const closeArgs = {
    cardId: runArgs.cardId,
    projectId: 'p1',
    root: '/home/me/app',
    pr: 41,
    deleteBranch: true,
    issue: null,
    comment: 'Closed from the Nautelle Board (C-12)',
  };

  it('accepts a close, with or without the issue', () => {
    expect(cardPrCloseArgsSchema.safeParse(closeArgs).success).toBe(true);
    expect(
      cardPrCloseArgsSchema.safeParse({
        ...closeArgs,
        deleteBranch: false,
        issue: 12,
      }).success,
    ).toBe(true);
  });

  it('rejects a branch name, command text, a relative root and a bad comment', () => {
    for (const bad of [
      { branch: 'main' },
      { command: 'gh pr close 41' },
      { root: 'app' },
      { pr: 0 },
      { deleteBranch: undefined },
      { comment: '' },
      { comment: 'a\u0000b' },
      { comment: 'x'.repeat(CARD_PR_CLOSE_COMMENT_MAX_BYTES + 1) },
    ]) {
      expect(
        cardPrCloseArgsSchema.safeParse({ ...closeArgs, ...bad }).success,
      ).toBe(false);
    }
  });

  it('a result is a close or a refusal with its reason', () => {
    expect(
      cardPrCloseResultSchema.safeParse({
        closed: true,
        alreadyClosed: false,
        branchDeleted: true,
        issueClosed: false,
      }).success,
    ).toBe(true);
    expect(
      cardPrCloseResultSchema.safeParse({
        closed: true,
        alreadyClosed: true,
        branchDeleted: false,
        branchError: 'HTTP 403',
        issueClosed: false,
        issueError: 'gh offline',
      }).success,
    ).toBe(true);
    expect(
      cardPrCloseResultSchema.safeParse({
        closed: false,
        error: 'merged',
        message: 'pull request #41 is merged',
      }).success,
    ).toBe(true);
    expect(
      cardPrCloseResultSchema.safeParse({
        closed: false,
        error: 'head_changed',
        message: 'x',
      }).success,
    ).toBe(false);
  });

  it('is an operator command, kept out of the allowlist until its handler lands', () => {
    const def = cardPrCloseCommands['card.prClose'];
    expect(def.minRole).toBe('operator');
    expect(def.timeoutMs).toBe(CARD_TIMEOUTS_MS.prClose);
    expect(Object.keys(cardCommands)).not.toContain('card.prClose');
  });
});

describe('cardCommands', () => {
  it('defines the five commands, each for an operator, with the D8 collect timeout', () => {
    expect(Object.keys(cardCommands).sort()).toEqual([
      'card.close',
      'card.collect',
      'card.merge',
      'card.run',
      'card.stop',
    ]);
    expect(cardCommands['card.merge'].timeoutMs).toBe(90_000);
    for (const def of Object.values(cardCommands)) {
      expect(def.minRole).toBe('operator');
    }
    expect(cardCommands['card.collect'].timeoutMs).toBe(180_000);
    expect(CARD_TIMEOUTS_MS.collect).toBe(180_000);
  });

  it('names the session from the short id', () => {
    expect(cardSessionName('ab12cd34')).toBe('nautelle-card-ab12cd34');
    expect(() => cardSessionName('nope')).toThrow();
    expect(cardShortIdSchema.safeParse('0a1b2c3d').success).toBe(true);
  });
});

describe('terminal target card', () => {
  const target = {
    kind: 'card',
    projectId: 'p1',
    root: '/home/me/app',
    cardId: runArgs.cardId,
  };

  it('parses a card target and nothing that names a session', () => {
    expect(terminalTargetSchema.safeParse(target).success).toBe(true);
    expect(
      terminalTargetSchema.safeParse({
        ...target,
        session: 'nautelle-card-ab12cd34',
      }).success,
    ).toBe(false);
    expect(
      terminalTargetSchema.safeParse({ ...target, cardId: '../x' }).success,
    ).toBe(false);
  });

  it('attaches to it', () => {
    expect(
      terminalAttachArgsSchema.safeParse({
        id: 't1',
        target,
        mode: 'write',
        cols: 80,
        rows: 24,
      }).success,
    ).toBe(true);
  });
});

describe('local method card.finish', () => {
  it('is an operator method of a project', () => {
    expect(localMethods['card.finish'].minRole).toBe('operator');
    expect(localMethods['card.finish'].needsProject).toBe(true);
  });

  it('takes only a bounded summary — the card comes from the session', () => {
    expect(parseLocalRequest('card.finish', { summary: 'Done.' }).ok).toBe(
      true,
    );
    expect(
      parseLocalRequest('card.finish', { summary: 'Done.', cardId: 'c1' }).ok,
    ).toBe(false);
    expect(parseLocalRequest('card.finish', { summary: '   ' }).ok).toBe(false);
    expect(
      parseLocalRequest('card.finish', { summary: 'x'.repeat(4001) }).ok,
    ).toBe(false);
  });
});
