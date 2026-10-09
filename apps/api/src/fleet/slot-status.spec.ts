import { worktreePath } from './projection';
import { deriveSlotStatus, type SlotStatusInputs } from './slot-status';

const inputs = (overrides: Partial<SlotStatusInputs>): SlotStatusInputs => ({
  sessionAlive: true,
  pane: null,
  worktreeExists: true,
  prState: null,
  ...overrides,
});

describe('deriveSlotStatus', () => {
  it.each([
    [null, 'running'],
    ['busy', 'running'],
    ['prompt', 'prompt'],
    ['idle', 'idle'],
    ['quota', 'quota'],
  ] as const)('a live session with pane %s is %s', (pane, status) => {
    expect(deriveSlotStatus(inputs({ pane }))).toBe(status);
  });

  it('stays live while the session runs, even after the PR merged', () => {
    expect(deriveSlotStatus(inputs({ prState: 'merged' }))).toBe('running');
  });

  it('is dispatched before any session was seen', () => {
    expect(deriveSlotStatus(inputs({ sessionAlive: null }))).toBe('dispatched');
  });

  it('is stale when the session died and the worktree remains unmerged', () => {
    expect(deriveSlotStatus(inputs({ sessionAlive: false }))).toBe('stale');
    expect(
      deriveSlotStatus(inputs({ sessionAlive: false, prState: 'closed' })),
    ).toBe('stale');
  });

  it('is ended when the session died and the PR merged or the worktree is gone', () => {
    expect(
      deriveSlotStatus(inputs({ sessionAlive: false, prState: 'merged' })),
    ).toBe('ended');
    expect(
      deriveSlotStatus(inputs({ sessionAlive: false, worktreeExists: false })),
    ).toBe('ended');
    expect(
      deriveSlotStatus(inputs({ sessionAlive: null, worktreeExists: false })),
    ).toBe('ended');
  });
});

describe('worktreePath', () => {
  it('follows dispatch.sh: <parent>/.wt-<repo>-<slot>', () => {
    expect(worktreePath('/home/a/dev/AgentDock', 'i42-api')).toBe(
      '/home/a/dev/.wt-AgentDock-i42-api',
    );
    expect(worktreePath('/home/a/dev/AgentDock/', 'i42')).toBe(
      '/home/a/dev/.wt-AgentDock-i42',
    );
    expect(worktreePath('/repo', 'i1')).toBe('/.wt-repo-i1');
  });
});
