import type {
  CardCiRetriggerArgs,
  CardCiRetriggerResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { watchedProject } from '../control/target';
import type { Exec } from '../detect/exec';
import { redactUrlUserinfo } from '../redact-url';
import { githubOf } from '../skills/run/collect';
import { firstLine, type Gh, ghOf, parsed } from './github';

export interface CardCiRetriggerDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
}

const prViewSchema = z.looseObject({
  state: z.string(),
  headRefOid: z.string(),
});

/** The comment the reopen leaves, so the closed/reopened pair explains itself. */
export const ciRetriggerComment = (headSha: string): string =>
  `AgentDock: no CI check reported on ${headSha.slice(0, 12)}, so the ` +
  'pull request was closed and reopened to send its event again (#484).';

/** `gh pr reopen`, once more when the first attempt fails. */
const reopen = async (gh: Gh, args: string[]) => {
  const first = await gh(args);
  if (first?.code === 0) return first;
  return gh(args);
};

/**
 * #484 (ADR-0043, ADR-0010): sends a card PR's pull-request event again so a
 * CI whose webhook delivery was lost creates its pipeline — `gh pr close`,
 * then `gh pr reopen --comment`, argument arrays only. Only an open PR whose
 * head is still `headSha` is touched. A refusal is a result, never a thrown
 * command error, except for a target that is not a watched project.
 */
export const retriggerCardCi = async (
  args: CardCiRetriggerArgs,
  deps: CardCiRetriggerDeps,
): Promise<CardCiRetriggerResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const gh = ghOf(deps.exec);
  const pr = String(args.pr);
  let github: string;
  try {
    github = await githubOf(deps, project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      retriggered: false,
      error: 'gh_failed',
      message: redactUrlUserinfo((message.split('\n')[0] ?? '').slice(0, 500)),
    };
  }
  const viewed = await gh([
    'pr',
    'view',
    pr,
    '--repo',
    github,
    '--json',
    'state,headRefOid',
  ]);
  const view = viewed?.code === 0 ? parsed(prViewSchema, viewed.stdout) : null;
  if (!view) {
    return {
      retriggered: false,
      error: 'gh_failed',
      message: firstLine(viewed),
    };
  }
  if (view.state !== 'OPEN') {
    return {
      retriggered: false,
      error: 'not_open',
      message: `pull request #${pr} is ${view.state.toLowerCase()}`,
    };
  }
  if (view.headRefOid !== args.headSha) {
    return {
      retriggered: false,
      error: 'head_moved',
      message: `pull request #${pr} moved on to ${view.headRefOid.slice(0, 12)}`,
    };
  }
  const closed = await gh(['pr', 'close', pr, '--repo', github]);
  if (closed?.code !== 0) {
    return {
      retriggered: false,
      error: 'gh_failed',
      message: firstLine(closed),
    };
  }
  const reopened = await reopen(gh, [
    'pr',
    'reopen',
    pr,
    '--repo',
    github,
    '--comment',
    ciRetriggerComment(args.headSha),
  ]);
  if (reopened?.code !== 0) {
    return {
      retriggered: false,
      error: 'reopen_failed',
      message: firstLine(reopened),
    };
  }
  return { retriggered: true };
};
