import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnsequencedEvent } from '@agentdock/shared/protocol';
import type { Exec, ExecResult } from '../detect/exec';
import { createLogger, type Logger } from '../log';

/** A fresh directory, removed by the returned cleanup. */
export const tempDir = (): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-runner-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** A logger whose lines are kept for assertions. */
export const memoryLogger = (): { log: Logger; lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
  };
};

/** An `Exec` answering from a table: `binary` → stdout; absent → not installed. */
export const fakeExec =
  (table: Record<string, string | ExecResult>): Exec =>
  async (binary, args) => {
    const key = [binary, ...args].join(' ');
    const answer = table[key] ?? table[binary];
    if (answer === undefined) return null;
    return typeof answer === 'string'
      ? { code: 0, stdout: answer, stderr: '' }
      : answer;
  };

/** A machine with everything installed except codex. */
export const machineWithoutCodex = (): Exec =>
  fakeExec({
    'tmux -V': 'tmux 3.5a\n',
    'tmux list-sessions -F #{session_name}': 'a\nb\n',
    'git --version': 'git version 2.55.0\n',
    'gh --version': 'gh version 2.80.0 (2026-08-20)\n',
    'gh auth status': {
      code: 0,
      stdout:
        'github.com\n  ✓ Logged in to github.com account AndreyBegma (keyring)\n',
      stderr: '',
    },
    'claude --version': '2.3.1 (Claude Code)\n',
  });

export const testEvent = (n: number): UnsequencedEvent => ({
  v: 1,
  ts: '2026-10-07T18:36:02.335Z',
  type: 'test.event',
  source: 'runner',
  data: { n },
});

/** A valid runner token (43 base64url characters). */
export const TOKEN = 'tok_SECRET_abcdefghijklmnopqrstuvwxyz012345';
