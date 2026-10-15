import { describe, expect, it } from 'bun:test';
import { TEXT_PROMPT_MAX_BYTES } from '../../text/limits';
import { commands } from '../commands';
import {
  textCommands,
  textNormalizeArgsSchema,
  textNormalizeResultSchema,
} from './text';

const args = {
  runId: 'cm1run00000000000000000001',
  projectId: 'p1',
  sessionId: '0b7c6a52-3a4f-4e0e-9a2c-5c1e2f3a4b5c',
  prompt: 'You translate short texts into English.',
  profileKey: 'claude-main',
  model: 'haiku',
  timeoutSec: 120,
};

const parse = (over: Record<string, unknown>) =>
  textNormalizeArgsSchema.safeParse({ ...args, ...over }).success;

describe('text.normalize args', () => {
  it('accepts a normalization', () => {
    expect(parse({})).toBe(true);
  });

  it('refuses any model but haiku', () => {
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
    expect(parse({ prompt: 'x'.repeat(TEXT_PROMPT_MAX_BYTES) })).toBe(true);
    expect(parse({ prompt: 'Ж'.repeat(TEXT_PROMPT_MAX_BYTES / 2 + 1) })).toBe(
      false,
    );
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
      textNormalizeResultSchema.safeParse({ phase: 'starting' }).success,
    ).toBe(true);
    expect(textNormalizeResultSchema.safeParse({ phase: 'done' }).success).toBe(
      false,
    );
  });
});

describe('textCommands', () => {
  it('is text.normalize for an operator', () => {
    expect(Object.keys(textCommands)).toEqual(['text.normalize']);
    expect(textCommands['text.normalize'].minRole).toBe('operator');
  });

  it('is on the allowlist, served by the runner', () => {
    expect(Object.hasOwn(commands, 'text.normalize')).toBe(true);
    expect(commands['text.normalize']).toBe(textCommands['text.normalize']);
  });
});
