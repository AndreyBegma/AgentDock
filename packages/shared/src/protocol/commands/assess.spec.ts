import { describe, expect, it } from 'bun:test';
import { CARD_ASSESS_PROMPT_MAX_BYTES } from '../../assess/limits';
import { commands } from '../commands';
import {
  assessCommands,
  cardAssessArgsSchema,
  cardAssessResultSchema,
} from './assess';

const args = {
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  sessionId: '0b7c6a52-3a4f-4e0e-9a2c-5c1e2f3a4b5c',
  prompt: 'Recommend a model for this card.',
  profileKey: 'claude-main',
  model: 'haiku',
  timeoutSec: 120,
};

const parse = (over: Record<string, unknown>) =>
  cardAssessArgsSchema.safeParse({ ...args, ...over }).success;

describe('card.assess args', () => {
  it('accepts an assessment', () => {
    expect(parse({})).toBe(true);
  });

  it('refuses any model but haiku (D5)', () => {
    for (const model of [
      'sonnet',
      'opus',
      '--dangerously-skip-permissions',
      '',
    ]) {
      expect(parse({ model })).toBe(false);
    }
  });

  it('bounds the timeout to 30–300 s', () => {
    expect(parse({ timeoutSec: 30 })).toBe(true);
    expect(parse({ timeoutSec: 300 })).toBe(true);
    expect(parse({ timeoutSec: 29 })).toBe(false);
    expect(parse({ timeoutSec: 301 })).toBe(false);
    expect(parse({ timeoutSec: 60.5 })).toBe(false);
  });

  it('bounds the prompt to 96 KiB and refuses NUL or empty', () => {
    expect(parse({ prompt: 'x'.repeat(CARD_ASSESS_PROMPT_MAX_BYTES) })).toBe(
      true,
    );
    expect(
      parse({ prompt: 'Ж'.repeat(CARD_ASSESS_PROMPT_MAX_BYTES / 2 + 1) }),
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
      { cardId: 'c1' },
    ]) {
      expect(parse(extra)).toBe(false);
    }
    expect(parse({ runId: '../x' })).toBe(false);
    expect(parse({ sessionId: 'abc' })).toBe(false);
    expect(parse({ profileKey: '-x' })).toBe(false);
  });

  it('answers with a phase', () => {
    expect(cardAssessResultSchema.safeParse({ phase: 'running' }).success).toBe(
      true,
    );
    expect(cardAssessResultSchema.safeParse({ phase: 'done' }).success).toBe(
      false,
    );
  });
});

describe('assessCommands', () => {
  it('is card.assess for an operator', () => {
    expect(Object.keys(assessCommands)).toEqual(['card.assess']);
    expect(assessCommands['card.assess'].minRole).toBe('operator');
  });

  it('is entered in the allowlist only with its runner handler', () => {
    // i322-runner adds `...assessCommands` to `commands` with the handler;
    // until then the runner build has no handler to serve it.
    const entry = (commands as Record<string, unknown>)['card.assess'];
    if (entry !== undefined) expect(entry).toBe(assessCommands['card.assess']);
  });
});
