import type {
  ApprovalSignalResult,
  PrApproveArgs,
  PrRequestChangesArgs,
  PrVoidApprovalArgs,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { Exec } from '../../detect/exec';
import { CommandFailure } from '../failure';
import { watchedById } from '../queue/project';
import { approvalsDirOf, type Signal, VOID_ACTOR, writeSignal } from './signal';

export interface DecideDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
}

/**
 * The watched project a command names, with `root` required to be exactly its
 * root: the runner never acts on a path the server merely sent (ADR-0010).
 */
export const projectRootOf = (
  args: { projectId: string; root: string },
  deps: Pick<DecideDeps, 'watchedProjects'>,
): string => {
  const project = watchedById(args.projectId, deps.watchedProjects());
  if (project.root !== args.root) {
    throw new CommandFailure(
      'path_not_allowed',
      `${args.root} is not the root of ${args.projectId}`,
    );
  }
  return project.root;
};

const decide = async (
  args: { projectId: string; root: string },
  deps: DecideDeps,
  signal: Signal,
): Promise<ApprovalSignalResult> => {
  const root = projectRootOf(args, deps);
  await writeSignal(await approvalsDirOf(deps.exec, root), signal);
  return { written: true };
};

/** `pr.approve` (D5): the orchestrator may merge `headSha`. */
export const prApprove = (args: PrApproveArgs, deps: DecideDeps) =>
  decide(args, deps, {
    v: 1,
    pr: args.pr,
    decision: 'approved',
    headSha: args.headSha,
    by: args.by,
    at: args.at,
  });

/** `pr.requestChanges` (D7): the orchestrator forwards `note` to the worker. */
export const prRequestChanges = (
  args: PrRequestChangesArgs,
  deps: DecideDeps,
) =>
  decide(args, deps, {
    v: 1,
    pr: args.pr,
    decision: 'changes_requested',
    headSha: args.headSha,
    note: args.note,
    by: args.by,
    at: args.at,
  });

/** `pr.voidApproval` (D6): the approved head was superseded; the file says `stale`. */
export const prVoidApproval = (args: PrVoidApprovalArgs, deps: DecideDeps) =>
  decide(args, deps, {
    v: 1,
    pr: args.pr,
    decision: 'stale',
    headSha: args.headSha,
    by: VOID_ACTOR,
    at: args.at,
  });
