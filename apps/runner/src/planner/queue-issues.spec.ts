import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { queueIssues } from './queue-issues';

let cleanup = () => {};
afterEach(() => cleanup());

/** A project whose origin is `acme/widget`; `gh issue edit` fails for `failing`. */
const setup = (options: { readyLabel?: string; failing?: number[] } = {}) => {
  const t = tempDir();
  cleanup = t.cleanup;
  const root = join(t.dir, 'widget');
  mkdirSync(root);
  if (options.readyLabel) {
    writeFileSync(
      join(root, '.code-analyzer-config.json'),
      JSON.stringify({ orchestrator: { readyLabel: options.readyLabel } }),
    );
  }
  const calls: string[][] = [];
  const exec: Exec = async (binary, args) => {
    if (binary === 'git' && args.includes('get-url')) {
      return {
        code: 0,
        stdout: 'git@github.com:acme/widget.git\n',
        stderr: '',
      };
    }
    if (binary !== 'gh') return { code: 1, stdout: '', stderr: 'no' };
    calls.push([...args]);
    const failing = options.failing ?? [];
    return failing.includes(Number(args[2]))
      ? {
          code: 1,
          stdout: '',
          stderr: 'GraphQL: Could not resolve to an Issue',
        }
      : { code: 0, stdout: '', stderr: '' };
  };
  const deps = {
    exec,
    watchedProjects: () => [{ id: 'prj_widget', root }],
    log: memoryLogger().log,
  };
  return { calls, deps };
};

describe('plan.queue_issues (D10)', () => {
  it('adds the label the command names to each issue', async () => {
    const { calls, deps } = setup({ readyLabel: 'from-config' });
    expect(
      await queueIssues(
        { projectId: 'prj_widget', numbers: [41, 42], readyLabel: 'ready!' },
        deps,
      ),
    ).toEqual({ labelled: [41, 42] });
    expect(calls).toEqual([
      ['issue', 'edit', '41', '--repo', 'acme/widget', '--add-label', 'ready!'],
      ['issue', 'edit', '42', '--repo', 'acme/widget', '--add-label', 'ready!'],
    ]);
  });

  it("falls back to the project's readyLabel, then to the default", async () => {
    const configured = setup({ readyLabel: 'from-config' });
    await queueIssues(
      { projectId: 'prj_widget', numbers: [1] },
      configured.deps,
    );
    expect(configured.calls[0]?.at(-1)).toBe('from-config');

    const plain = setup();
    await queueIssues({ projectId: 'prj_widget', numbers: [1] }, plain.deps);
    expect(plain.calls[0]?.at(-1)).toBe('cs:ready');
  });

  it('reports the issues it labelled when one fails, and fails only when none does', async () => {
    const partial = setup({ failing: [42] });
    expect(
      await queueIssues(
        { projectId: 'prj_widget', numbers: [41, 42, 43] },
        partial.deps,
      ),
    ).toEqual({ labelled: [41, 43] });

    const none = setup({ failing: [41] });
    const error = await queueIssues(
      { projectId: 'prj_widget', numbers: [41] },
      none.deps,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandFailure);
    expect((error as CommandFailure).code).toBe('upstream_unavailable');
    expect((error as CommandFailure).message).toContain('Could not resolve');
  });

  it('refuses a project the runner does not watch', async () => {
    const { deps } = setup();
    const error = await queueIssues(
      { projectId: 'prj_other', numbers: [1] },
      deps,
    ).catch((e: unknown) => e);
    expect((error as CommandFailure).code).toBe('path_not_allowed');
  });
});
