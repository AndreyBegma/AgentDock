import { describe, expect, it } from 'bun:test';
import { runningBackgroundTasks, shortenCommand } from './background';

/** Transcript lines as Claude Code 2.1 writes them (compact JSON). */
const use = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  });

const result = (toolUseId: string, toolUseResult: Record<string, unknown>) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content: '' }],
    },
    toolUseResult,
  });

const notification = (taskId: string, status: string | null) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n${
      status ? `<status>${status}</status>\n` : ''
    }<summary>…</summary>\n</task-notification>`,
  });

const sessionStart = (source: string) =>
  JSON.stringify({
    type: 'attachment',
    attachment: {
      type: 'hook_success',
      hookName: `SessionStart:${source}`,
      hookEvent: 'SessionStart',
    },
  });

const transcript = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('runningBackgroundTasks (#390)', () => {
  it('a background Bash runs until its notification has a status', () => {
    const started = [
      use('tu_1', 'Bash', {
        command: 'while pgrep -f jest; do sleep 10; done',
        run_in_background: true,
      }),
      result('tu_1', { stdout: '', backgroundTaskId: 'bx4pluw49' }),
    ];
    expect(runningBackgroundTasks(transcript(...started))).toEqual([
      { id: 'bx4pluw49', command: 'while pgrep -f jest; do sleep 10; done' },
    ]);
    expect(
      runningBackgroundTasks(
        transcript(...started, notification('bx4pluw49', 'failed')),
      ),
    ).toEqual([]);
  });

  it('counts a command its timeout moved to the background, a Monitor and an async Agent', () => {
    const lines = transcript(
      use('tu_1', 'Bash', { command: 'bun run test' }),
      result('tu_1', { backgroundTaskId: 'b1', timedOutAfterMs: 600000 }),
      use('tu_2', 'Monitor', { command: 'watch.sh', description: 'fleet' }),
      result('tu_2', { taskId: 'b2', persistent: false }),
      use('tu_3', 'Agent', { description: 'Gap sweep', prompt: 'p' }),
      result('tu_3', { status: 'async_launched', agentId: 'a3' }),
      // A Monitor event is a notification without a status.
      notification('b2', null),
    );
    expect(runningBackgroundTasks(lines)).toEqual([
      { id: 'b1', command: 'bun run test' },
      { id: 'b2', command: 'watch.sh' },
      { id: 'a3', command: 'Gap sweep' },
    ]);
  });

  it('a finished foreground command and a notification quoted in a command are not tasks', () => {
    const lines = transcript(
      use('tu_1', 'Bash', { command: 'ls' }),
      result('tu_1', { stdout: 'a', stderr: '' }),
      use('tu_2', 'Bash', { command: 'sleep 60', run_in_background: true }),
      result('tu_2', { backgroundTaskId: 'b2' }),
      use('tu_3', 'Bash', {
        command:
          'echo "<task-notification><task-id>b2</task-id><status>completed</status>"',
      }),
    );
    expect(runningBackgroundTasks(lines).map((t) => t.id)).toEqual(['b2']);
  });

  it('a new Claude Code process owns none of the earlier tasks', () => {
    const before = [
      use('tu_1', 'Bash', { command: 'sleep 600', run_in_background: true }),
      result('tu_1', { backgroundTaskId: 'b1' }),
    ];
    expect(
      runningBackgroundTasks(transcript(...before, sessionStart('resume'))),
    ).toEqual([]);
    // A compaction keeps the process, and its tasks.
    expect(
      runningBackgroundTasks(transcript(...before, sessionStart('compact'))),
    ).toHaveLength(1);
  });

  it('skips lines that are not JSON', () => {
    expect(runningBackgroundTasks('{"backgroundTaskId": \n\nnot json')).toEqual(
      [],
    );
  });
});

describe('shortenCommand', () => {
  it('keeps the first line, collapses spaces and cuts long commands', () => {
    expect(shortenCommand('cd /x;   bun   test', 80)).toBe('cd /x; bun test');
    expect(shortenCommand('\nset -e\nbun test\n', 80)).toBe('set -e…');
    expect(shortenCommand('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`);
  });
});
