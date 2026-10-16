import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureSpawn } from '../capture/executor';
import type { ConfigProfile } from '../config';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { STEWARD_CLASSIFIER_MODEL, StewardClassifier } from './classifier';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const PROFILE: ConfigProfile = {
  id: 'claude-work',
  runtime: 'claude',
  env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' },
  args: ['--strict-mcp-config'],
};

const resultLine = (result: string, isError = false) =>
  `${JSON.stringify({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result })}\n`;

const setup = (stdout: string, code = 0) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-steward-'));
  dirs.push(dir);
  const calls: {
    command: readonly string[];
    env: Record<string, string>;
    prompt: string;
  }[] = [];
  const spawn: CaptureSpawn = ({ command, env, stdinFile }) => {
    calls.push({ command, env, prompt: readFileSync(stdinFile, 'utf8') });
    return {
      exited: Promise.resolve(code),
      stdout: Promise.resolve(stdout),
      stderr: Promise.resolve(''),
      kill: () => {},
    };
  };
  const classifier = new StewardClassifier({
    dir,
    env: { PATH: '/usr/bin' },
    clock: new FakeClock(),
    log: memoryLogger().log,
    spawn,
  });
  return { dir, calls, classifier };
};

describe('StewardClassifier (#447 D3)', () => {
  it('runs haiku headless on the profile, hooks off, and returns its one line', async () => {
    const t = setup(
      resultLine('"A wait loop polls pgrep -f and matches itself."\n\nMore.'),
    );
    const result = await t.classifier.classify(
      PROFILE,
      'prj_widget',
      '● Bash(until ! pgrep -f jest; do sleep 5; done)',
      10,
    );
    expect(result?.reason).toBe(
      'A wait loop polls pgrep -f and matches itself.',
    );
    expect(result?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const [call] = t.calls;
    expect(call?.command).toEqual([
      'claude',
      '--strict-mcp-config',
      '-p',
      '--tools',
      '',
      '--permission-mode',
      'plan',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      STEWARD_CLASSIFIER_MODEL,
      '--session-id',
      result?.sessionId ?? '',
    ]);
    expect(call?.env.AGENTDOCK_HOOKS).toBe('off');
    expect(call?.env.CLAUDE_CONFIG_DIR).toBe('/home/dev/.claude-work');
    expect(call?.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'agentdock.project=prj_widget',
    );
    expect(call?.prompt).toContain('until ! pgrep -f jest');
    expect(call?.prompt).toContain('10 minutes');
    // The prompt carries pane text: its directory is gone afterwards.
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it('a failed run, an error result or no answer is null', async () => {
    for (const [stdout, code] of [
      [resultLine('x'), 1],
      [resultLine('x', true), 0],
      ['', 0],
      [resultLine('   '), 0],
    ] as const) {
      const t = setup(stdout, code);
      expect(
        await t.classifier.classify(PROFILE, 'prj_widget', 'tail', 10),
      ).toBeNull();
    }
  });

  it('never runs on a codex profile', async () => {
    const t = setup(resultLine('x'));
    expect(
      await t.classifier.classify(
        { id: 'codex', runtime: 'codex', env: {}, args: [] },
        'prj_widget',
        'tail',
        10,
      ),
    ).toBeNull();
    expect(t.calls).toEqual([]);
  });
});
