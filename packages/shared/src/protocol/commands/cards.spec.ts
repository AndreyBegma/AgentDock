import { describe, expect, it } from 'bun:test';
import { localMethods, parseLocalRequest } from '../local';
import {
  CARD_RUN_FILE_MAX_BYTES,
  CARD_RUN_PROMPT_MAX_BYTES,
  CARD_TIMEOUTS_MS,
  cardCloseArgsSchema,
  cardCollectArgsSchema,
  cardCollectResultSchema,
  cardCommands,
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
  prompt: 'You are the dedicated worker for AgentDock board card C-12.',
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

  it('takes at most four repository-relative files of bounded size', () => {
    const file = (path: string, content = '') => ({ path, content });
    const parse = (files: unknown) =>
      cardRunArgsSchema.safeParse({ ...runArgs, files }).success;
    expect(parse(['a', 'b', 'c', 'd'].map((p) => file(`${p}.md`)))).toBe(true);
    expect(parse(['a', 'b', 'c', 'd', 'e'].map((p) => file(`${p}.md`)))).toBe(
      false,
    );
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
        tmuxSession: 'agentdock-card-ab12cd34',
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

describe('cardCommands', () => {
  it('defines the four commands, each for an operator, with the D8 collect timeout', () => {
    expect(Object.keys(cardCommands).sort()).toEqual([
      'card.close',
      'card.collect',
      'card.run',
      'card.stop',
    ]);
    for (const def of Object.values(cardCommands)) {
      expect(def.minRole).toBe('operator');
    }
    expect(cardCommands['card.collect'].timeoutMs).toBe(180_000);
    expect(CARD_TIMEOUTS_MS.collect).toBe(180_000);
  });

  it('names the session from the short id', () => {
    expect(cardSessionName('ab12cd34')).toBe('agentdock-card-ab12cd34');
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
        session: 'agentdock-card-ab12cd34',
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
