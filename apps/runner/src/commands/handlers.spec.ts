import { describe, expect, it } from 'bun:test';
import type { CardCommandName } from '@agentdock/shared/protocol';
import type { CardHandlers } from '../cards';
import { FakeClock } from '../testing/fake-clock';
import { fakeExec } from '../testing/fixtures';
import { CommandFailure } from './failure';
import { createHandlers, type HandlerContext } from './handlers';

const context = (over: Partial<HandlerContext> = {}): HandlerContext => ({
  clock: new FakeClock(),
  runnerVersion: '0.1.0',
  host: { hostname: 'test-host', os: 'linux', arch: 'x64' },
  detectCapabilities: async () => ({
    tmux: null,
    git: null,
    gh: null,
    runtimes: { claude: null, codex: null },
    profiles: [],
    codeSentinel: null,
    otlp: null,
  }),
  exec: fakeExec({}),
  watchedProjects: () => [],
  profiles: () => [],
  ...over,
});

const CARD = { cardId: 'card_1', projectId: 'prj_a' };
const cases: [CardCommandName, unknown][] = [
  ['card.stop', CARD],
  ['card.close', { ...CARD, removeWorktree: true }],
];

describe('card command handlers (#242)', () => {
  it('answers unsupported on a runner without the card executor', async () => {
    const handlers = createHandlers(context());
    for (const [name, args] of cases) {
      const outcome = await Promise.resolve()
        .then(() => (handlers[name] as (a: unknown) => unknown)(args))
        .then(
          () => 'resolved',
          (error: unknown) =>
            error instanceof CommandFailure ? error.code : String(error),
        );
      expect(outcome).toBe('unsupported');
    }
  });

  it('hands every card command to the card executor', async () => {
    const seen: string[] = [];
    const cards: CardHandlers = {
      'card.run': async () => {
        seen.push('card.run');
        return { phase: 'running', tmuxSession: 'agentdock-card-ab12cd34' };
      },
      'card.stop': async () => {
        seen.push('card.stop');
        return { stopped: true };
      },
      'card.collect': async () => {
        seen.push('card.collect');
        return { ahead: 0, pushed: false };
      },
      'card.close': async () => {
        seen.push('card.close');
        return { stopped: false, worktreeRemoved: true, branchDeleted: false };
      },
    };
    const handlers = createHandlers(context({ cards }));
    expect(await handlers['card.stop'](CARD)).toEqual({ stopped: true });
    expect(
      await handlers['card.close']({ ...CARD, removeWorktree: true }),
    ).toEqual({ stopped: false, worktreeRemoved: true, branchDeleted: false });
    expect(
      await handlers['card.collect']({
        ...CARD,
        root: '/srv/app',
        base: 'main',
        branch: 'card/c1-x',
        number: 1,
        title: 'X',
        body: '',
      }),
    ).toEqual({ ahead: 0, pushed: false });
    expect(seen).toEqual(['card.stop', 'card.close', 'card.collect']);
  });
});
