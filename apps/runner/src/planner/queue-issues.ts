import { DEFAULT_READY_LABEL } from '@nautelle/shared';
import type {
  PlanQueueIssuesArgs,
  PlanQueueIssuesResult,
  WatchedProject,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { readyLabelOf, watchedById } from '../commands/queue/project';
import type { Exec } from '../detect/exec';
import { resolveFleetProject } from '../fleet/project';
import { errorMessage, type Logger } from '../log';
import { GH_TIMEOUT_MS, stderrLine } from '../skills/deps';

export interface QueueIssuesDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
  log: Logger;
}

/**
 * `plan.queue_issues` (D10): the ready label on each issue —
 * `args.readyLabel`, else the project's `orchestrator.readyLabel`, else the
 * default, as `issue.create` chooses it. Each issue is labelled on its own;
 * the result lists the ones that were, so the API can retry the rest. Only a
 * run where none succeeds is an error.
 */
export const queueIssues = async (
  args: PlanQueueIssuesArgs,
  deps: QueueIssuesDeps,
): Promise<PlanQueueIssuesResult> => {
  const project = watchedById(args.projectId, deps.watchedProjects());
  const fleet = await resolveFleetProject(deps.exec, project);
  if (!fleet.github) {
    throw new CommandFailure(
      'not_a_repository',
      `${project.root} has no GitHub remote`,
    );
  }
  const label =
    args.readyLabel ?? readyLabelOf(project.root) ?? DEFAULT_READY_LABEL;
  const labelled: number[] = [];
  let lastError = '';
  for (const number of args.numbers) {
    try {
      const result = await deps.exec(
        'gh',
        [
          'issue',
          'edit',
          String(number),
          '--repo',
          fleet.github,
          '--add-label',
          label,
        ],
        { timeoutMs: GH_TIMEOUT_MS },
      );
      if (result?.code === 0) {
        labelled.push(number);
        continue;
      }
      lastError = stderrLine(result);
    } catch (error) {
      lastError = errorMessage(error);
    }
    deps.log.warn('planner: cannot queue an issue', {
      issue: number,
      error: lastError,
    });
  }
  if (labelled.length === 0) {
    throw new CommandFailure(
      'upstream_unavailable',
      `gh issue edit failed: ${lastError}`,
    );
  }
  return { labelled };
};
