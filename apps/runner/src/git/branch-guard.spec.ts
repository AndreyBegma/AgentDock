import { describe, expect, it } from 'bun:test';
import type { Gh } from '../cards/github';
import { CommandFailure } from '../commands/failure';
import type { Exec, ExecResult } from '../detect/exec';
import { pushBranch } from '../skills/run/collect';
import { assertPushAllowed } from './branch-guard';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** A `gh` answering the default branch and one branch read. */
const fakeGh =
  (defaultBranch: ExecResult, branch: ExecResult): Gh =>
  async (args) =>
    args[0] === 'repo' ? defaultBranch : branch;

const main = ok(JSON.stringify({ defaultBranchRef: { name: 'main' } }));

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'allowed',
    (e: unknown) => (e instanceof CommandFailure ? e.code : 'error'),
  );

describe('assertPushAllowed (C-148)', () => {
  it('refuses the default branch before asking about the branch', async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return args[0] === 'repo' ? main : ok('{"protected":false}');
    };
    expect(await outcome(assertPushAllowed(gh, 'acme/x', 'main'))).toBe(
      'branch_refused',
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses a protected branch and allows one GitHub does not know yet', async () => {
    const protectedBranch = fakeGh(main, ok('{"protected":true}'));
    expect(
      await outcome(assertPushAllowed(protectedBranch, 'acme/x', 'card/c1-a')),
    ).toBe('branch_refused');
    const missing = fakeGh(main, fail('gh: Branch not found (HTTP 404)'));
    expect(
      await outcome(assertPushAllowed(missing, 'acme/x', 'card/c1-a')),
    ).toBe('allowed');
    const open = fakeGh(main, ok('{"protected":false}'));
    expect(await outcome(assertPushAllowed(open, 'acme/x', 'card/c1-a'))).toBe(
      'allowed',
    );
  });

  it('fails as an ordinary error, never allowed, when GitHub cannot be read', async () => {
    const noDefault = fakeGh(fail('HTTP 502'), ok('{"protected":false}'));
    expect(
      await outcome(assertPushAllowed(noDefault, 'acme/x', 'card/c1-a')),
    ).toBe('error');
    const noBranch = fakeGh(main, fail('HTTP 502'));
    expect(
      await outcome(assertPushAllowed(noBranch, 'acme/x', 'card/c1-a')),
    ).toBe('error');
  });

  it('asks about a branch with slashes by its path', async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      return args[0] === 'repo' ? main : ok('{"protected":false}');
    };
    await assertPushAllowed(gh, 'acme/x', 'feat/42-a#b');
    expect(calls[1]).toEqual(['api', 'repos/acme/x/branches/feat/42-a%23b']);
  });
});

describe('skill run pushBranch (C-148)', () => {
  it('refuses a branch outside run/ without running git or gh', async () => {
    const calls: string[] = [];
    const exec: Exec = async (binary) => {
      calls.push(binary);
      return ok('');
    };
    expect(
      await outcome(pushBranch({ exec }, 'acme/x', '/tmp/wt', 'main')),
    ).toBe('branch_refused');
    expect(calls).toEqual([]);
  });
});
