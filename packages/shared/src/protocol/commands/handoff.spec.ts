import { describe, expect, it } from 'bun:test';
import { HANDOFF_NOTE_TEMPLATE } from '../../handoff/note';
import { capabilitiesSchema, handoffAvailable } from '../capabilities';
import { isCommandName } from '../commands';
import {
  cardHandoffSetArgsSchema,
  cardHandoffSetResultSchema,
  HANDOFF_COMMAND_NAMES,
  handoffCommands,
} from './handoff';

const content = HANDOFF_NOTE_TEMPLATE.replace(
  '## Goal\n',
  '## Goal\nShip it.\n',
);
const args = {
  projectId: 'p1',
  cardId: 'cmcard01',
  shortId: 'ab12cd34',
  content,
  personLines: [{ from: 2, to: 2 }],
};

describe('card.handoff.set (#449 D7)', () => {
  const ok = (a: unknown) => cardHandoffSetArgsSchema.safeParse(a).success;

  it('takes a valid note for a card worktree', () => {
    expect(ok(args)).toBe(true);
  });

  it('takes no path and nothing unknown', () => {
    expect(ok({ ...args, worktree: '/tmp/x' })).toBe(false);
  });

  it('refuses an invalid note or person lines past the end', () => {
    expect(ok({ ...args, content: '## Goal\nx\n' })).toBe(false);
    expect(ok({ ...args, personLines: [{ from: 900, to: 900 }] })).toBe(false);
    expect(ok({ ...args, shortId: 'NOT-OK' })).toBe(false);
  });

  it('answers applied or no_worktree', () => {
    expect(
      cardHandoffSetResultSchema.safeParse({ outcome: 'applied' }).success,
    ).toBe(true);
    expect(
      cardHandoffSetResultSchema.safeParse({ outcome: 'failed' }).success,
    ).toBe(false);
  });

  it('is an operator command', () => {
    expect(handoffCommands['card.handoff.set'].minRole).toBe('operator');
    expect(HANDOFF_COMMAND_NAMES).toEqual(['card.handoff.set']);
  });

  it('is in the allowlist, with the runner handler beside it', () => {
    expect(isCommandName('card.handoff.set')).toBe(true);
  });
});

describe('handoff capability', () => {
  const base = {
    tmux: null,
    git: null,
    gh: null,
    runtimes: { claude: null, codex: null },
    profiles: [],
    codeSentinel: null,
    otlp: null,
  };

  it('is false when absent — a runner older than Context handoff', () => {
    expect(handoffAvailable(capabilitiesSchema.parse(base))).toBe(false);
    expect(
      handoffAvailable(capabilitiesSchema.parse({ ...base, handoff: true })),
    ).toBe(true);
  });
});
