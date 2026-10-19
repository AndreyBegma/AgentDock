import type {
  CardPrRetargetArgs,
  CardPrRetargetResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { watchedProject } from '../control/target';
import type { Exec } from '../detect/exec';
import { redactUrlUserinfo } from '../redact-url';
import { githubOf } from '../skills/run/collect';
import { firstLine, ghOf, parsed } from './github';

export interface CardPrRetargetDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
}

const prViewSchema = z.looseObject({
  state: z.string(),
  baseRefName: z.string(),
});

/**
 * #636 (ADR-0063, ADR-0010): moves a stacked card PR onto `base` once the
 * dependency it was stacked on has merged — `gh pr view`, then `gh pr edit
 * --base`, argument arrays only. Only an open PR is edited; one already on
 * `base` is left alone. A refusal is a result, never a thrown command error,
 * except for a target that is not a watched project.
 */
export const retargetCardPr = async (
  args: CardPrRetargetArgs,
  deps: CardPrRetargetDeps,
): Promise<CardPrRetargetResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const gh = ghOf(deps.exec);
  const pr = String(args.pr);
  let github: string;
  try {
    github = await githubOf(deps, project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      retargeted: false,
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
    'state,baseRefName',
  ]);
  const view = viewed?.code === 0 ? parsed(prViewSchema, viewed.stdout) : null;
  if (!view) {
    return {
      retargeted: false,
      error: 'gh_failed',
      message: firstLine(viewed),
    };
  }
  if (view.state !== 'OPEN') {
    return {
      retargeted: false,
      error: 'not_open',
      message: `pull request #${pr} is ${view.state.toLowerCase()}`,
    };
  }
  if (view.baseRefName === args.base) {
    return { retargeted: true, alreadyThere: true };
  }
  const edited = await gh([
    'pr',
    'edit',
    pr,
    '--repo',
    github,
    '--base',
    args.base,
  ]);
  if (edited?.code !== 0) {
    return {
      retargeted: false,
      error: 'gh_failed',
      message: firstLine(edited),
    };
  }
  return { retargeted: true, alreadyThere: false };
};
