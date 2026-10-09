import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_READY_LABEL, specGap } from '@agentdock/shared';
import type {
  IssueCreateArgs,
  IssueCreateResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { Exec } from '../../detect/exec';
import { resolveFleetProject } from '../../fleet/project';
import { CommandFailure } from '../failure';
import { readyLabelOf, watchedById } from './project';

/** Under the command's own 45 s, so a stuck `gh` fails here with a message, not as a dispatcher timeout. */
export const GH_CREATE_TIMEOUT_MS = 40_000;

export interface IssueCreateDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
  /** Where the body file goes; default: a fresh directory under the OS temp dir. */
  tempRoot?: string;
}

const ISSUE_URL =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\s*$/m;

/** The URL `gh issue create` prints on its last line, and the number in it. */
export const parseCreated = (
  stdout: string,
): { number: number; url: string } | null => {
  const match = ISSUE_URL.exec(stdout);
  return match ? { number: Number(match[1]), url: match[0].trim() } : null;
};

/**
 * `issue.create` (spec 19 D7): `gh issue create --repo <owner/repo>` with the
 * body in a temp file — never in argv. With `queue`, the ready label is added
 * only when the body passes `specGap`; otherwise the issue is created without
 * it and the result says why. The API refuses that case first; this is the
 * second line of defence.
 */
export const issueCreate = async (
  args: IssueCreateArgs,
  deps: IssueCreateDeps,
): Promise<IssueCreateResult> => {
  const project = watchedById(args.projectId, deps.watchedProjects());
  const fleet = await resolveFleetProject(deps.exec, project);
  if (!fleet.github) {
    throw new CommandFailure(
      'not_a_repository',
      `${project.root} has no GitHub remote`,
    );
  }

  const readyLabel =
    args.readyLabel ?? readyLabelOf(project.root) ?? DEFAULT_READY_LABEL;
  // The ready label is never taken from the caller: only `queue` may set it.
  const labels = args.labels.filter(
    (l) => l.toLowerCase() !== readyLabel.toLowerCase(),
  );
  const reason = args.queue ? specGap(args.body, labels) : null;
  const queued = args.queue && reason === null;
  if (queued) labels.push(readyLabel);

  const dir = await mkdtemp(
    join(deps.tempRoot ?? tmpdir(), 'agentdock-issue-'),
  );
  try {
    const bodyFile = join(dir, 'body.md');
    await writeFile(bodyFile, args.body, { mode: 0o600 });
    const result = await deps.exec(
      'gh',
      [
        'issue',
        'create',
        '--repo',
        fleet.github,
        '--title',
        args.title,
        '--body-file',
        bodyFile,
        ...labels.flatMap((l) => ['--label', l]),
      ],
      { timeoutMs: GH_CREATE_TIMEOUT_MS },
    );
    if (!result) {
      throw new Error('gh is not available or timed out');
    }
    if (result.code !== 0) {
      throw new Error(
        `gh issue create failed: ${result.stderr.trim().split('\n')[0] ?? ''}`,
      );
    }
    const created = parseCreated(result.stdout);
    if (!created) throw new Error('gh issue create printed no issue URL');
    return { ...created, queued, ...(reason ? { reason } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
