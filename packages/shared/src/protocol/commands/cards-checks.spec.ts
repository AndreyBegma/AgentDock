import { describe, expect, it } from 'bun:test';
import { commands } from '../commands';
import {
  CARD_CHECKS_MAX,
  CARD_TIMEOUTS_MS,
  cardChecksArgsSchema,
  cardChecksCommands,
  cardChecksResultSchema,
  cardRunArgsSchema,
} from './cards';

/** #359: the contracts a card that ships itself adds to the card commands. */

const runArgs = {
  cardId: 'cm1card0000000000000000001',
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  root: '/home/me/app',
  base: 'develop',
  shortId: 'ab12cd34',
  branch: 'card/c12-add-login',
  session: { id: '0b7c6a52-3a4f-4e0e-9a2c-5c1e2f3a4b5c', resume: false },
  prompt: 'You are the dedicated worker for AgentDock board card C-12.',
  profileKey: 'claude-main',
  model: 'opus',
  permissionMode: 'acceptEdits',
};

const draft = {
  title: 'C-12: Add login',
  body: 'Work in progress.\n\nAgentDock-Card: C-12',
};

describe('card.run draft PR and follow-up branch (#359 D1, D8)', () => {
  it('accepts a round with a draft PR to open', () => {
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, pullRequest: draft }).success,
    ).toBe(true);
  });

  it('is unchanged without them — an API older than #359', () => {
    const parsed = cardRunArgsSchema.parse(runArgs);
    expect(parsed.pullRequest).toBeUndefined();
    expect(parsed.newBranch).toBeUndefined();
  });

  it('refuses a multi-line title, an unknown field or a NUL body', () => {
    for (const pullRequest of [
      { ...draft, title: 'C-12\nrm -rf' },
      { ...draft, title: '' },
      { ...draft, body: 'a\u0000b' },
      { ...draft, draft: false },
    ]) {
      expect(
        cardRunArgsSchema.safeParse({ ...runArgs, pullRequest }).success,
      ).toBe(false);
    }
  });

  it('never pushes the base branch', () => {
    expect(
      cardRunArgsSchema.safeParse({
        ...runArgs,
        branch: 'develop',
        pullRequest: draft,
      }).success,
    ).toBe(false);
  });

  it('takes newBranch on a resumed round only', () => {
    const resumed = { ...runArgs.session, resume: true };
    expect(
      cardRunArgsSchema.safeParse({
        ...runArgs,
        branch: 'card/c12-add-login-2',
        session: resumed,
        newBranch: true,
      }).success,
    ).toBe(true);
    expect(
      cardRunArgsSchema.safeParse({ ...runArgs, newBranch: true }).success,
    ).toBe(false);
  });
});

const head = 'a'.repeat(40);

describe('card.checks (#359 D5)', () => {
  it('takes a card target, the project root and a PR number', () => {
    expect(
      cardChecksArgsSchema.safeParse({
        cardId: runArgs.cardId,
        projectId: 'p1',
        root: '/home/me/app',
        pr: 42,
      }).success,
    ).toBe(true);
    for (const bad of [
      { pr: 0 },
      { root: 'relative/path' },
      { command: 'gh pr checks 42' },
    ]) {
      expect(
        cardChecksArgsSchema.safeParse({
          cardId: runArgs.cardId,
          projectId: 'p1',
          root: '/home/me/app',
          pr: 42,
          ...bad,
        }).success,
      ).toBe(false);
    }
  });

  it('reads the head, the merge state and every check', () => {
    const parsed = cardChecksResultSchema.parse({
      state: 'draft',
      headSha: head,
      mergeable: 'CONFLICTING',
      checks: [
        {
          name: 'ci/woodpecker/pr/check',
          bucket: 'fail',
          link: 'https://ci.example/1',
        },
        { name: 'lint', bucket: 'pass', link: null },
      ],
    });
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.mergeable).toBe('CONFLICTING');
  });

  it('accepts a PR with no checks', () => {
    expect(
      cardChecksResultSchema.safeParse({
        state: 'open',
        headSha: head,
        mergeable: 'MERGEABLE',
        checks: [],
      }).success,
    ).toBe(true);
  });

  it('refuses a short head, an unknown bucket, a non-https link and too many checks', () => {
    const ok = {
      state: 'open',
      headSha: head,
      mergeable: 'UNKNOWN',
      checks: [] as unknown[],
    };
    const check = { name: 'lint', bucket: 'pass', link: null };
    for (const bad of [
      { ...ok, headSha: 'abc123' },
      { ...ok, checks: [{ ...check, bucket: 'SUCCESS' }] },
      { ...ok, checks: [{ ...check, link: 'http://ci.example/1' }] },
      { ...ok, checks: Array(CARD_CHECKS_MAX + 1).fill(check) },
    ]) {
      expect(cardChecksResultSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is an operator command with its own timeout, not yet in the allowlist', () => {
    const def = cardChecksCommands['card.checks'];
    expect(def.minRole).toBe('operator');
    expect(def.timeoutMs).toBe(CARD_TIMEOUTS_MS.checks);
    // The runner slot enters it together with its handler.
    expect(Object.hasOwn(commands, 'card.checks')).toBe(false);
  });
});
