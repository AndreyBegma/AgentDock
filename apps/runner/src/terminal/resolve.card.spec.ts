import { describe, expect, it } from 'bun:test';
import type { TerminalTarget } from '@nautelle/shared/protocol';
import type { Exec } from '../detect/exec';
import { type ResolveDeps, resolveTerminalTarget } from './resolve';

const SESSION = 'nautelle-card-ab12cd34';
const project = { id: 'prj_1', root: '/home/u/dev/app' };
const other = { id: 'prj_2', root: '/home/u/dev/other' };

const target: TerminalTarget = {
  kind: 'card',
  projectId: 'prj_1',
  root: project.root,
  cardId: 'card_1',
};

const tmuxWith =
  (...names: string[]): Exec =>
  async (_binary, args) =>
    args.includes('list-sessions')
      ? {
          code: 0,
          stdout: names.map((n) => `${n}|:|1700000000\n`).join(''),
          stderr: '',
        }
      : { code: 0, stdout: '', stderr: '' };

/** The executor's lookup: card_1 is prj_1's, card_2 is prj_2's. */
const cards: Record<string, { projectId: string; root: string }> = {
  card_1: { projectId: 'prj_1', root: project.root },
  card_2: { projectId: 'prj_2', root: other.root },
};

const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  exec: tmuxWith(SESSION, 'nautelle-card-zz99yy88'),
  watchedProjects: () => [project, other],
  cardSession: (projectId, root, cardId) => {
    const card = cards[cardId];
    if (!card || card.projectId !== projectId || card.root !== root)
      return null;
    return cardId === 'card_1' ? SESSION : 'nautelle-card-zz99yy88';
  },
  ...over,
});

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

describe('resolving a card terminal target (#242)', () => {
  it("resolves the card's nautelle-card-* session", async () => {
    expect(await resolveTerminalTarget(target, deps())).toBe(SESSION);
  });

  it("refuses another project's card as not_found", async () => {
    const theirs = { ...target, cardId: 'card_2' };
    expect(await code(resolveTerminalTarget(theirs, deps()))).toBe('not_found');
  });

  it('refuses a card this runner has no worker for', async () => {
    const unknown = { ...target, cardId: 'card_9' };
    expect(await code(resolveTerminalTarget(unknown, deps()))).toBe(
      'not_found',
    );
  });

  it('refuses a card whose session is gone', async () => {
    expect(
      await code(resolveTerminalTarget(target, deps({ exec: tmuxWith() }))),
    ).toBe('not_found');
  });

  it('refuses a looked-up name that is not nautelle-card-<shortid>', async () => {
    const bad = deps({
      cardSession: () => 'cs-main',
      exec: tmuxWith('cs-main'),
    });
    expect(await code(resolveTerminalTarget(target, bad))).toBe('not_found');
  });

  it('refuses a project outside the watch list', async () => {
    const unwatched = {
      ...target,
      projectId: 'prj_3',
      root: '/home/u/dev/third',
    };
    expect(await code(resolveTerminalTarget(unwatched, deps()))).toBe(
      'not_found',
    );
  });

  it('is unsupported on a runner without the card lookup', async () => {
    expect(
      await code(
        resolveTerminalTarget(target, deps({ cardSession: undefined })),
      ),
    ).toBe('unsupported');
  });
});
