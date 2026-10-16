import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STEWARD_PANE_TAIL_MAX_BYTES } from '@agentdock/shared';
import { paneTail, readPane } from './pane-rules';

const fixture = (name: string): string =>
  readFileSync(
    join(import.meta.dir, '..', 'collectors', 'tmux', '__fixtures__', name),
    'utf8',
  );

const BOX_TOP = '╭──────────────────────────────────────────────╮';
const BOX_BOTTOM = '╰──────────────────────────────────────────────╯';
const PROMPT = (typed = '') =>
  [BOX_TOP, `│ > ${typed.padEnd(43)}│`, BOX_BOTTOM].join('\n');
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';

/** A pane whose last output is `lines`, then the input box. */
const pane = (lines: string[], typed = ''): string =>
  [...lines, '', PROMPT(typed), FOOTER, ''].join('\n');

describe('readPane (#447 D6, D9, D11)', () => {
  it('reads the API error of the spec fixture at an idle prompt', () => {
    const reading = readPane(
      pane([
        '● Running the checks.',
        '  ⎿  API Error: Connection lost mid-response',
      ]),
    );
    expect(reading).toEqual({
      state: 'idle',
      signal: {
        kind: 'api_error',
        reason: 'API error: the connection was lost mid-response',
      },
    });
  });

  it('a pane still retrying the call is busy, not an API error', () => {
    const reading = readPane(
      pane([
        '  ⎿  API Error (Connection error.) · Retrying in 5 seconds… (attempt 2/10)',
        '✻ Compacting… (12s · esc to interrupt)',
      ]),
    );
    expect(reading).toEqual({ state: 'busy', signal: null });
  });

  it('an API error far above the input box is history, not the last output', () => {
    const old = ['  ⎿  API Error: Connection lost mid-response'];
    const since = Array.from({ length: 20 }, (_, i) => `● step ${i} done`);
    expect(readPane(pane([...old, ...since]))).toEqual({
      state: 'idle',
      signal: null,
    });
  });

  it('a half-typed input is not idle: nothing may be typed over it', () => {
    expect(readPane(pane(['● Done.'], 'fix the'))).toEqual({
      state: 'other',
      signal: null,
    });
  });

  it('the empty prompt and the busy fixtures', () => {
    expect(readPane(fixture('empty-prompt.txt'))).toEqual({
      state: 'idle',
      signal: null,
    });
    expect(readPane(fixture('busy.txt'))).toEqual({
      state: 'busy',
      signal: null,
    });
  });

  it('the quota banner', () => {
    expect(readPane(fixture('quota.txt')).signal).toEqual({
      kind: 'quota',
      reason: 'the usage limit is reached',
    });
  });

  it('a listed dialog carries its id (#435 list)', () => {
    const text = [
      BOX_TOP,
      '│ Teach auto mode about your environment?      │',
      '│ ❯ 1. Yes                                     │',
      '│   2. Not now                                 │',
      "│   3. Don't show again                        │",
      BOX_BOTTOM,
    ].join('\n');
    expect(readPane(text)).toEqual({
      state: 'other',
      signal: {
        kind: 'dialog',
        reason: 'a known dialog blocks the session (teach-auto-mode)',
        dialogId: 'teach-auto-mode',
      },
    });
  });

  it('an unlisted dialog has no id: it can never be dismissed', () => {
    for (const name of ['trust.txt', 'settings.txt', 'credits.txt']) {
      const reading = readPane(fixture(name));
      expect(reading.signal?.kind).toBe('dialog');
      expect(reading.signal).not.toHaveProperty('dialogId');
    }
    const generic = [
      BOX_TOP,
      '│ Pick an output style                         │',
      '│ ❯ 1. Default                                 │',
      '│   2. Explanatory                             │',
      BOX_BOTTOM,
      '   Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(readPane(generic).signal).toEqual({
      kind: 'dialog',
      reason: 'an unknown dialog blocks the session',
    });
  });

  it('a permission prompt wins over everything, a listed dialog included', () => {
    const prompt = [
      BOX_TOP,
      '│ Bash command                                 │',
      '│   rm -rf build                               │',
      '│ Do you want to proceed?                      │',
      '│ ❯ 1. Yes                                     │',
      '│   2. No, and tell Claude what to do differently (esc) │',
      BOX_BOTTOM,
    ].join('\n');
    expect(readPane(prompt).signal).toEqual({
      kind: 'permission_prompt',
      reason: 'a permission prompt waits for a person',
    });
    const both = `${prompt}\nTeach auto mode about your environment?\n 2. Not now`;
    expect(readPane(both).signal?.kind).toBe('permission_prompt');
  });

  it('a worker asking "Do you want to proceed?" in its own text is not a permission prompt', () => {
    const reading = readPane(
      pane(['● The plan is ready. Do you want to proceed?']),
    );
    expect(reading).toEqual({ state: 'idle', signal: null });
  });

  it('a reason is never pane text', () => {
    const reading = readPane(
      pane(['  ⎿  API Error: 500 secret-token-sk-abcdefghijklmnopqrstuvwx']),
    );
    expect(reading.signal?.reason).toBe('API error: the response was cut off');
  });
});

describe('paneTail (#447 D12)', () => {
  it('keeps the last lines within the byte limit, redacted', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    lines.push('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
    const tail = paneTail(`${lines.join('\n')}\n\n`) ?? '';
    expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(
      STEWARD_PANE_TAIL_MAX_BYTES,
    );
    expect(tail.endsWith('GITHUB_TOKEN=•••')).toBe(true);
    expect(tail).not.toContain('ghp_');
    expect(tail).toContain('line 1999');
    expect(tail).not.toContain('line 0\n');
  });

  it('is null for a blank pane', () => {
    expect(paneTail('\n  \n')).toBeNull();
  });
});
