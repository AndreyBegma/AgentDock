import { describe, expect, it } from 'bun:test';
import { commands } from '../commands';
import {
  CAPTURE_PROMPT_MAX_BYTES,
  captureCommands,
  cardsExtractArgsSchema,
  cardsExtractResultSchema,
  HOOKS_ENV,
  HOOKS_OFF,
  HOOKS_OFF_ENV,
  hooksDisabled,
} from './capture';

const args = {
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  sessionId: '0b7c6a52-3a4f-4e0e-9a2c-5c1e2f3a4b5c',
  prompt: 'You read excerpts of one developer’s session.',
  profileKey: 'claude-main',
  model: 'haiku',
  timeoutSec: 180,
};

const parse = (over: Record<string, unknown>) =>
  cardsExtractArgsSchema.safeParse({ ...args, ...over }).success;

describe('cards.extract args', () => {
  it('accepts an extraction', () => {
    expect(parse({})).toBe(true);
    expect(parse({ model: 'sonnet' })).toBe(true);
  });

  it('refuses any model but haiku or sonnet', () => {
    for (const model of ['opus', '--dangerously-skip-permissions', '']) {
      expect(parse({ model })).toBe(false);
    }
  });

  it('bounds the timeout to 30–600 s', () => {
    expect(parse({ timeoutSec: 30 })).toBe(true);
    expect(parse({ timeoutSec: 600 })).toBe(true);
    expect(parse({ timeoutSec: 29 })).toBe(false);
    expect(parse({ timeoutSec: 601 })).toBe(false);
    expect(parse({ timeoutSec: 60.5 })).toBe(false);
  });

  it('bounds the prompt to 48 KiB and refuses NUL or empty', () => {
    expect(parse({ prompt: 'x'.repeat(CAPTURE_PROMPT_MAX_BYTES) })).toBe(true);
    expect(
      parse({ prompt: '語'.repeat(CAPTURE_PROMPT_MAX_BYTES / 3 + 1) }),
    ).toBe(false);
    expect(parse({ prompt: 'a\u0000b' })).toBe(false);
    expect(parse({ prompt: '' })).toBe(false);
  });

  it('refuses a field that would name a path, tools or a command', () => {
    for (const extra of [
      { cwd: '/home/me/app' },
      { tools: 'Bash' },
      { command: 'rm -rf /' },
      { permissionMode: 'bypassPermissions' },
    ]) {
      expect(parse(extra)).toBe(false);
    }
    expect(parse({ runId: '../x' })).toBe(false);
    expect(parse({ sessionId: 'abc' })).toBe(false);
    expect(parse({ profileKey: '-x' })).toBe(false);
  });

  it('answers with a phase', () => {
    expect(
      cardsExtractResultSchema.safeParse({ phase: 'running' }).success,
    ).toBe(true);
    expect(cardsExtractResultSchema.safeParse({ phase: 'done' }).success).toBe(
      false,
    );
  });
});

describe('captureCommands', () => {
  it('is cards.extract for an operator', () => {
    expect(Object.keys(captureCommands)).toEqual(['cards.extract']);
    expect(captureCommands['cards.extract'].minRole).toBe('operator');
  });

  it('is on the allowlist, now that the runner serves it', () => {
    expect(Object.hasOwn(commands, 'cards.extract')).toBe(true);
    expect(commands['cards.extract']).toBe(captureCommands['cards.extract']);
  });
});

describe('hook suppression', () => {
  it('turns hooks off under either name during the rename window (ADR-0073)', () => {
    expect(hooksDisabled({ AGENTDOCK_HOOKS: 'off' })).toBe(true);
    expect(
      hooksDisabled({ NAUTELLE_HOOKS: 'on', AGENTDOCK_HOOKS: 'off' }),
    ).toBe(false);
    expect(HOOKS_OFF_ENV).toEqual({
      NAUTELLE_HOOKS: 'off',
      AGENTDOCK_HOOKS: 'off',
    });
  });

  it('turns hooks off only for NAUTELLE_HOOKS=off', () => {
    expect(HOOKS_ENV).toBe('NAUTELLE_HOOKS');
    expect(hooksDisabled({ [HOOKS_ENV]: HOOKS_OFF })).toBe(true);
    expect(hooksDisabled({ NAUTELLE_HOOKS: 'OFF' })).toBe(false);
    expect(hooksDisabled({ NAUTELLE_HOOKS: '0' })).toBe(false);
    expect(hooksDisabled({})).toBe(false);
  });
});
