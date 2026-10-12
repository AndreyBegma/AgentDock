import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  commands,
  PR_INSPECT_BODY_MAX_BYTES,
  PR_INSPECT_FILES_MAX,
  prApproveArgsSchema,
  prInspectArgsSchema,
  prRequestChangesArgsSchema,
  prVoidApprovalArgsSchema,
} from '@agentdock/shared/protocol';
import type { Exec, ExecResult } from '../../detect/exec';
import { FakeClock } from '../../testing/fake-clock';
import { REAL_PROCESS_TIMEOUT_MS, workspace } from '../../testing/projects';
import { CommandFailure } from '../failure';
import { prApprove, prRequestChanges, prVoidApproval } from './decide';
import { prInspect, trimBytes } from './inspect';
import { signalPath, writeSignal } from './signal';

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const AT = '2026-10-09T10:00:00.000Z';

/** Every file below `dir`, relative to it, sorted. */
const tree = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
};

describe('approvals runner commands', () => {
  let ws: ReturnType<typeof workspace>;
  let root = '';
  beforeEach(async () => {
    ws = workspace();
    root = await ws.repo('widget', 'git@github.com:acme/widget.git');
  });
  afterEach(() => ws.cleanup());

  const watched = () => [{ id: 'prj_1', root }];
  let target = { projectId: 'prj_1', root, pr: 7 };
  let decision = { ...target, headSha: HEAD, by: 'ada@example.com', at: AT };
  beforeEach(() => {
    target = { projectId: 'prj_1', root, pr: 7 };
    decision = { ...target, headSha: HEAD, by: 'ada@example.com', at: AT };
  });
  const approvalsDir = () => join(root, '.git', 'cs-orchestrator', 'approvals');
  const read = (pr: number) =>
    JSON.parse(readFileSync(join(approvalsDir(), `${pr}.json`), 'utf8'));
  const deps = () => ({ exec: ws.git, watchedProjects: watched });

  describe('the allowlist', () => {
    it('lists the four commands, so a handler exists for each (registration trap)', () => {
      for (const name of [
        'pr.inspect',
        'pr.approve',
        'pr.requestChanges',
        'pr.voidApproval',
      ]) {
        expect(Object.hasOwn(commands, name)).toBe(true);
      }
    });
  });

  describe('the signal', () => {
    it(
      'pr.approve writes decision "approved" for the head, atomically, in the approvals directory',
      async () => {
        const args = prApproveArgsSchema.parse(decision);
        expect(await prApprove(args, deps())).toEqual({ written: true });
        expect(read(7)).toEqual({
          v: 1,
          pr: 7,
          decision: 'approved',
          headSha: HEAD,
          by: 'ada@example.com',
          at: AT,
        });
        // No temp file is left behind.
        expect(readdirSync(approvalsDir())).toEqual(['7.json']);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'pr.requestChanges writes decision "changes_requested" and the note',
      async () => {
        const args = prRequestChangesArgsSchema.parse({
          ...decision,
          note: 'Please cover the empty case.\nThanks.',
        });
        await prRequestChanges(args, deps());
        expect(read(7)).toMatchObject({
          decision: 'changes_requested',
          note: 'Please cover the empty case.\nThanks.',
          headSha: HEAD,
        });
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'pr.voidApproval rewrites an approval as "stale", attributed to agentdock',
      async () => {
        await prApprove(prApproveArgsSchema.parse(decision), deps());
        await prVoidApproval(
          prVoidApprovalArgsSchema.parse({
            ...target,
            headSha: HEAD,
            at: '2026-10-09T10:05:00.000Z',
          }),
          deps(),
        );
        expect(read(7)).toEqual({
          v: 1,
          pr: 7,
          decision: 'stale',
          headSha: HEAD,
          by: 'agentdock',
          at: '2026-10-09T10:05:00.000Z',
        });
        expect(readdirSync(approvalsDir())).toEqual(['7.json']);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'a later decision replaces the file whole: concurrent writes never leave a partial file',
      async () => {
        const writes = Array.from({ length: 20 }, (_, i) =>
          prRequestChanges(
            prRequestChangesArgsSchema.parse({
              ...decision,
              note: `note ${i} ${'x'.repeat(2000)}`,
            }),
            deps(),
          ),
        );
        await Promise.all(writes);
        expect(read(7).note).toMatch(/^note \d+ x{2000}$/);
        expect(readdirSync(approvalsDir())).toEqual(['7.json']);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'keeps one file per PR',
      async () => {
        await prApprove(prApproveArgsSchema.parse(decision), deps());
        await prApprove(
          prApproveArgsSchema.parse({ ...decision, pr: 8, headSha: MOVED }),
          deps(),
        );
        expect(readdirSync(approvalsDir()).sort()).toEqual([
          '7.json',
          '8.json',
        ]);
        expect(read(8).headSha).toBe(MOVED);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );
  });

  describe('where a handler may write', () => {
    it(
      'writes nothing outside <git-common-dir>/cs-orchestrator/approvals/',
      async () => {
        ws.files({ 'widget/README.md': 'hello\n' });
        const before = tree(root).filter((p) => !p.startsWith('.git/'));
        const gitBefore = tree(join(root, '.git'));

        await prApprove(prApproveArgsSchema.parse(decision), deps());
        await prRequestChanges(
          prRequestChangesArgsSchema.parse({ ...decision, note: 'n' }),
          deps(),
        );
        await prVoidApproval(
          prVoidApprovalArgsSchema.parse({ ...target, headSha: HEAD, at: AT }),
          deps(),
        );

        expect(tree(root).filter((p) => !p.startsWith('.git/'))).toEqual(
          before,
        );
        const added = tree(join(root, '.git')).filter(
          (p) => !gitBefore.includes(p),
        );
        expect(added).toEqual(['cs-orchestrator/approvals/7.json']);
        // The workspace holds nothing else either.
        expect(readdirSync(ws.ws)).toEqual(['widget']);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it('refuses a target outside the approvals directory', async () => {
      const dir = join(root, '.git', 'cs-orchestrator', 'approvals');
      mkdirSync(dir, { recursive: true });
      const signal = {
        v: 1 as const,
        pr: 7,
        decision: 'approved' as const,
        headSha: HEAD,
        by: 'ada',
        at: AT,
      };
      for (const target of [
        join(root, 'README.md'),
        join(dir, '..', '7.json'),
        join(dir, 'nested', '7.json'),
        dir,
      ]) {
        await expect(writeSignal(dir, signal, target)).rejects.toMatchObject({
          code: 'path_not_allowed',
        });
      }
      expect(tree(root).filter((p) => !p.startsWith('.git/'))).toEqual([]);
    });

    it('builds the target from an integer PR number only', () => {
      const dir = '/x/approvals';
      expect(signalPath(dir, 12)).toBe('/x/approvals/12.json');
      for (const pr of [0, -1, 1.5, Number.NaN]) {
        expect(() => signalPath(dir, pr)).toThrow(CommandFailure);
      }
    });

    it(
      'refuses a root that is not the watched project, and a project that is not watched',
      async () => {
        const other = await ws.repo('other');
        await expect(
          prApprove(
            prApproveArgsSchema.parse({ ...decision, root: other }),
            deps(),
          ),
        ).rejects.toMatchObject({ code: 'path_not_allowed' });
        await expect(
          prApprove(
            prApproveArgsSchema.parse({ ...decision, projectId: 'prj_x' }),
            deps(),
          ),
        ).rejects.toMatchObject({ code: 'path_not_allowed' });
        expect(() =>
          readdirSync(join(other, '.git', 'cs-orchestrator')),
        ).toThrow();
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it('says not_a_repository for a watched root that is not a git checkout', async () => {
      const plain = join(ws.ws, 'plain');
      mkdirSync(plain);
      await expect(
        prApprove(prApproveArgsSchema.parse({ ...decision, root: plain }), {
          exec: ws.git,
          watchedProjects: () => [{ id: 'prj_1', root: plain }],
        }),
      ).rejects.toMatchObject({ code: 'not_a_repository' });
    });
  });

  describe('pr.inspect', () => {
    const ok = (stdout: string): ExecResult => ({
      code: 0,
      stdout,
      stderr: '',
    });
    const view = (over: Record<string, unknown> = {}) => ({
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      files: [
        { path: 'src/a.ts', additions: 10, deletions: 1 },
        { path: 'src/b.ts', additions: 2, deletions: 2 },
      ],
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://ci.example/1',
        },
        { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' },
      ],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      url: 'https://github.com/acme/widget/pull/7',
      title: 'Add widget',
      body: 'The merge summary',
      state: 'OPEN',
      headRefOid: HEAD,
      ...over,
    });

    const setup = (gh: ExecResult | null) => {
      const ghCalls: { args: string[]; timeoutMs?: number }[] = [];
      const exec: Exec = async (binary, args, options) => {
        if (binary !== 'gh') return ws.git(binary, args);
        ghCalls.push({ args: [...args], timeoutMs: options?.timeoutMs });
        return gh;
      };
      const run = () =>
        prInspect(prInspectArgsSchema.parse(target), {
          exec,
          clock: new FakeClock(),
          watchedProjects: watched,
        });
      return { ghCalls, run };
    };

    it(
      'runs gh with fixed argv for the exact PR and maps the answer',
      async () => {
        const { ghCalls, run } = setup(ok(JSON.stringify(view())));
        const result = await run();
        expect(ghCalls).toHaveLength(1);
        expect(ghCalls[0].args).toEqual([
          'pr',
          'view',
          '7',
          '--repo',
          'acme/widget',
          '--json',
          'additions,deletions,changedFiles,files,statusCheckRollup,mergeable,mergeStateStatus,url,title,body,state,headRefOid',
        ]);
        expect(ghCalls[0].timeoutMs).toBeLessThan(30_000);
        expect(result).toMatchObject({
          number: 7,
          url: 'https://github.com/acme/widget/pull/7',
          title: 'Add widget',
          body: 'The merge summary',
          state: 'open',
          headSha: HEAD,
          additions: 12,
          deletions: 3,
          changedFiles: 2,
          filesTruncated: false,
          checks: 'green',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          checkList: [
            { name: 'build', state: 'pass', url: 'https://ci.example/1' },
            { name: 'lint', state: 'pass' },
          ],
        });
        expect(result.files).toHaveLength(2);
        expect(result.fetchedAt).toBe(
          new Date(new FakeClock().now()).toISOString(),
        );
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'classifies failing and running checks, and a merged PR',
      async () => {
        const { run } = setup(
          ok(
            JSON.stringify(
              view({
                state: 'MERGED',
                statusCheckRollup: [
                  { name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' },
                  { name: 'b', status: 'IN_PROGRESS', conclusion: '' },
                  { context: 'c', state: 'PENDING' },
                ],
              }),
            ),
          ),
        );
        const result = await run();
        expect(result.state).toBe('merged');
        expect(result.checks).toBe('red');
        expect(result.checkList.map((c) => c.state)).toEqual([
          'fail',
          'wait',
          'wait',
        ]);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'caps the file list at 300 and says so; trims a huge body on a character boundary',
      async () => {
        const files = Array.from(
          { length: PR_INSPECT_FILES_MAX + 25 },
          (_, i) => ({
            path: `f${i}.ts`,
            additions: 1,
            deletions: 0,
          }),
        );
        const { run } = setup(
          ok(
            JSON.stringify(
              view({
                files,
                changedFiles: files.length,
                body: 'é'.repeat(PR_INSPECT_BODY_MAX_BYTES),
              }),
            ),
          ),
        );
        const result = await run();
        expect(result.files).toHaveLength(PR_INSPECT_FILES_MAX);
        expect(result.filesTruncated).toBe(true);
        expect(result.changedFiles).toBe(PR_INSPECT_FILES_MAX + 25);
        expect(
          new TextEncoder().encode(result.body).length,
        ).toBeLessThanOrEqual(PR_INSPECT_BODY_MAX_BYTES);
        expect(result.body).not.toContain('�');
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'treats a PR without checks as green',
      async () => {
        const { run } = setup(
          ok(JSON.stringify(view({ statusCheckRollup: null }))),
        );
        const result = await run();
        expect(result.checks).toBe('green');
        expect(result.checkList).toEqual([]);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'answers upstream_unavailable when gh is absent, fails, or prints rubbish',
      async () => {
        for (const gh of [
          null,
          { code: 1, stdout: '', stderr: 'no pull requests found' },
          ok('not json'),
          ok(JSON.stringify({ title: 'only a title' })),
          ok(JSON.stringify(view({ headRefOid: 'nope' }))),
          ok(JSON.stringify(view({ state: 'DRAFT' }))),
        ]) {
          await expect(setup(gh).run()).rejects.toMatchObject({
            code: 'upstream_unavailable',
          });
        }
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it(
      'refuses a root that is not the watched one, without calling gh',
      async () => {
        const { ghCalls } = setup(ok('{}'));
        await expect(
          prInspect(
            prInspectArgsSchema.parse({ ...target, root: '/elsewhere' }),
            {
              exec: ws.git,
              clock: new FakeClock(),
              watchedProjects: watched,
            },
          ),
        ).rejects.toMatchObject({ code: 'path_not_allowed' });
        expect(ghCalls).toEqual([]);
      },
      REAL_PROCESS_TIMEOUT_MS,
    );

    it('refuses a project without a GitHub remote', async () => {
      const bare = await ws.repo('bare');
      const { ghCalls } = setup(ok('{}'));
      await expect(
        prInspect(prInspectArgsSchema.parse({ ...target, root: bare }), {
          exec: ws.git,
          clock: new FakeClock(),
          watchedProjects: () => [{ id: 'prj_1', root: bare }],
        }),
      ).rejects.toMatchObject({ code: 'not_a_repository' });
      expect(ghCalls).toEqual([]);
    });
  });

  describe('trimBytes', () => {
    it('keeps short text and cuts long text within the budget', () => {
      expect(trimBytes('abc', 10)).toBe('abc');
      expect(trimBytes('é'.repeat(10), 5)).toBe('éé');
    });
  });
});
