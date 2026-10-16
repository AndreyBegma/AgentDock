import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureSpawn } from '../capture/executor';
import type { ConfigProfile } from '../config';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { HANDOFF_WRITER_MODEL, HandoffWriter, unwrapNote } from './haiku';

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

const PROFILE: ConfigProfile = {
  id: 'claude-work',
  runtime: 'claude',
  env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' },
  args: [],
};

describe('HandoffWriter (#449 D2)', () => {
  it('runs haiku headless, hooks off, and deletes the prompt', async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const calls: {
      command: readonly string[];
      env: Record<string, string>;
      prompt: string;
    }[] = [];
    const spawn: CaptureSpawn = ({ command, env, stdinFile }) => {
      calls.push({ command, env, prompt: readFileSync(stdinFile, 'utf8') });
      return {
        exited: Promise.resolve(0),
        stdout: Promise.resolve(
          `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```markdown\n## Goal\nx\n```' })}\n`,
        ),
        stderr: Promise.resolve(''),
        kill: () => {},
      };
    };
    const writer = new HandoffWriter({
      dir,
      env: { PATH: '/usr/bin' },
      clock: new FakeClock(),
      log: memoryLogger().log,
      spawn,
    });
    const note = await writer.write(
      PROFILE,
      'p1',
      '[user] build it',
      '## Goal\nold <!-- person -->',
    );
    expect(note).toBe('## Goal\nx');
    expect(calls[0]?.command).toContain(HANDOFF_WRITER_MODEL);
    expect(calls[0]?.command).toContain('-p');
    expect(calls[0]?.env.AGENTDOCK_HOOKS).toBe('off');
    expect(calls[0]?.prompt).toContain('[user] build it');
    expect(calls[0]?.prompt).toContain('old <!-- person -->');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('answers null for a failed call or a codex profile', async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const writer = new HandoffWriter({
      dir,
      env: {},
      clock: new FakeClock(),
      log: memoryLogger().log,
      spawn: () => ({
        exited: Promise.resolve(1),
        stdout: Promise.resolve(''),
        stderr: Promise.resolve(''),
        kill: () => {},
      }),
    });
    expect(await writer.write(PROFILE, 'p1', 'x', null)).toBeNull();
    expect(
      await writer.write({ ...PROFILE, runtime: 'codex' }, 'p1', 'x', null),
    ).toBeNull();
    expect(readdirSync(join(dir))).toEqual([]);
  });

  it('unwraps a fenced answer', () => {
    expect(unwrapNote('```md\n## Goal\ny\n```')).toBe('## Goal\ny');
    expect(unwrapNote('  ## Goal\ny  ')).toBe('## Goal\ny');
  });
});
