import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillRunChangedFile,
  SkillRunTerminalPhase,
} from '@agentdock/shared/protocol';
import { resolveFleetProject } from '../../fleet/project';
import { redact } from '../../pane/redact';
import {
  GH_TIMEOUT_MS,
  gitOk,
  NETWORK_TIMEOUT_MS,
  NO_HOOKS,
  parsePrUrl,
  type SkillsDeps,
  stderrLine,
} from '../deps';
import { parsePorcelain } from './finished';
import type { RunRecord, RunStore } from './record';
import { finalResult } from './stream';

/** Why the session is over. */
export type EndReason = 'exited' | 'vanished' | 'cancelled' | 'timed_out';

/** A stream larger than this is read from its tail for the final `result`. */
const STREAM_TAIL_BYTES = 8 * 1024 * 1024;

export interface Collected {
  phase: SkillRunTerminalPhase;
  exitCode: number | null;
  reportText: string | null;
  changedFiles: SkillRunChangedFile[];
  changedFilesTotal: number;
  patch: string | null;
  pr?: { number: number; url: string };
  /** `owner/repo` the PR was opened on; the cleanup job asks it about the PR. */
  prGithub?: string;
  error?: string;
  /** `pr` output with an open PR: the cleanup job removes the worktree later. */
  keepWorktree: boolean;
}

/** The last `max` bytes of a file; `''` when it cannot be read. */
const readTail = (path: string, max: number): string => {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
};

const lastStderrLine = (path: string): string | null => {
  const lines = readTail(path, 64 * 1024)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last ? redact([last])[0]!.slice(0, 300) : null;
};

const changes = async (
  deps: SkillsDeps,
  record: RunRecord,
  patchFile: string,
) => {
  const { exec } = deps;
  const wt = record.worktree;
  const status = await gitOk(exec, [
    '-C',
    wt,
    'status',
    '--porcelain=v1',
    '-z',
    '-uall',
  ]);
  const { files, total } = parsePorcelain(status);
  // Staged so untracked files are in the diff; commits the skill made are too.
  await gitOk(exec, ['-C', wt, 'add', '-A']);
  const patch = record.baseCommit
    ? await gitOk(exec, [
        '-C',
        wt,
        'diff',
        '--cached',
        '--no-color',
        '--no-ext-diff',
        record.baseCommit,
      ])
    : '';
  writeFileSync(patchFile, patch, { mode: 0o600 });
  return { files, total, patch, dirty: status.length > 0 };
};

/** D10 `pr`: commit what is left, push when ahead, open the PR into the base. */
const openPr = async (
  deps: SkillsDeps,
  record: RunRecord,
  dirty: boolean,
  report: string | null,
): Promise<{ number: number; url: string; github: string } | null> => {
  const { exec } = deps;
  const wt = record.worktree;
  const title = `chore(skill): ${record.skill} run ${record.shortId}`;
  if (dirty) {
    await gitOk(exec, [
      '-C',
      wt,
      ...NO_HOOKS,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      title,
    ]);
  }
  const ahead = Number(
    (
      await gitOk(exec, [
        '-C',
        wt,
        'rev-list',
        '--count',
        `${record.baseCommit}..HEAD`,
      ])
    ).trim(),
  );
  if (!(ahead > 0)) return null;
  const github = await githubOf(deps, record);
  await gitOk(
    exec,
    [
      '-C',
      wt,
      ...NO_HOOKS,
      'push',
      '--quiet',
      'origin',
      `HEAD:refs/heads/${record.branch}`,
    ],
    NETWORK_TIMEOUT_MS,
  );
  const dir = await mkdtemp(join(deps.tempRoot ?? tmpdir(), 'agentdock-pr-'));
  try {
    const bodyFile = join(dir, 'body.md');
    await writeFile(
      bodyFile,
      [
        `Skill run \`${record.runId}\`: \`/${record.skill}\` on \`${record.base}\`.`,
        '',
        report
          ? redact(report.split('\n')).join('\n')
          : 'The run left no report.',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const created = await exec(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        github,
        '--base',
        record.base,
        '--head',
        record.branch,
        '--title',
        title,
        '--body-file',
        bodyFile,
      ],
      { timeoutMs: GH_TIMEOUT_MS },
    );
    if (!created || created.code !== 0) {
      throw new Error(`gh pr create failed: ${stderrLine(created)}`);
    }
    const pr = parsePrUrl(created.stdout);
    if (!pr) throw new Error('gh pr create printed no pull request URL');
    return { ...pr, github };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const githubOf = async (
  deps: SkillsDeps,
  record: RunRecord,
): Promise<string> => {
  const fleet = await resolveFleetProject(deps.exec, {
    id: record.projectId,
    root: record.root,
  });
  if (!fleet.github) throw new Error(`${record.root} has no GitHub remote`);
  return fleet.github;
};

/**
 * D10/D11: what a finished session leaves — the final `result`, the changed
 * files, the patch against the base and, for a successful `pr` run, the PR.
 * A cancelled, timed-out or failed run is collected the same way but never
 * pushed (spec 24, notes).
 */
export const collectRun = async (
  deps: SkillsDeps,
  store: RunStore,
  record: RunRecord,
  reason: EndReason,
): Promise<Collected> => {
  const exit = store.exit(record.runId);
  const exitCode = exit?.code ?? null;
  const result = finalResult(
    readTail(store.file(record.runId, 'stream'), STREAM_TAIL_BYTES),
  );
  const reportText = result?.text ?? null;

  let phase: SkillRunTerminalPhase;
  let error: string | undefined;
  if (reason === 'cancelled') phase = 'cancelled';
  else if (reason === 'timed_out') {
    phase = 'timed_out';
    error = `the run exceeded its ${record.timeoutSec} s timeout`;
  } else if (reason === 'vanished' || exit === null) {
    phase = 'failed';
    error = 'the session ended without an exit status';
  } else if (exitCode !== 0) {
    phase = 'failed';
    error =
      lastStderrLine(store.file(record.runId, 'stderr')) ??
      `the profile binary exited with code ${exitCode}`;
  } else if (!result) {
    phase = 'failed';
    error = 'the session produced no result message';
  } else if (result.isError) {
    phase = 'failed';
    error = 'the session ended with an error result';
  } else phase = 'succeeded';

  const collected: Collected = {
    phase,
    exitCode,
    reportText,
    changedFiles: [],
    changedFilesTotal: 0,
    patch: null,
    keepWorktree: false,
    ...(error ? { error } : {}),
  };
  if (!existsSync(record.worktree) || !record.baseCommit) return collected;

  const found = await changes(deps, record, store.file(record.runId, 'patch'));
  collected.changedFiles = found.files;
  collected.changedFilesTotal = found.total;
  collected.patch = found.patch || null;
  if (record.output !== 'pr' || phase !== 'succeeded') return collected;

  try {
    const pr = await openPr(deps, record, found.dirty, reportText);
    if (pr) {
      collected.pr = { number: pr.number, url: pr.url };
      collected.prGithub = pr.github;
      collected.keepWorktree = true;
    } else if (!reportText) {
      collected.reportText = 'No changes.';
    }
  } catch (e) {
    collected.phase = 'failed';
    collected.error = e instanceof Error ? e.message : String(e);
  }
  return collected;
};
