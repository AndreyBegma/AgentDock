import {
  orchestratorSessionName,
  type TerminalTarget,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { resolveSlot, watchedProject } from '../control/target';
import { TmuxControl } from '../control/tmux';
import type { Exec } from '../detect/exec';
import { resolveFleetProject } from '../fleet/project';

export interface ResolveDeps {
  exec: Exec;
  /** The current watch list, as the server last sent it. */
  watchedProjects: () => readonly WatchedProject[];
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
}

/** Codes of the shared resolvers that mean "not a target of this project". */
const NOT_THIS_PROJECT = new Set(['path_not_allowed', 'not_a_repository']);

const notFound = (message: string) => new CommandFailure('not_found', message);

/**
 * D2: the only place a terminal target becomes a tmux session name. The wire
 * names what to attach to, never a session; a target that does not resolve,
 * or resolves into another project, is `not_found`.
 */
export const resolveTerminalTarget = async (
  target: TerminalTarget,
  deps: ResolveDeps,
): Promise<string> => {
  try {
    return await resolve(target, deps);
  } catch (error) {
    if (error instanceof CommandFailure && NOT_THIS_PROJECT.has(error.code)) {
      throw notFound(error.message);
    }
    throw error;
  }
};

const resolve = async (
  target: TerminalTarget,
  deps: ResolveDeps,
): Promise<string> => {
  const project = watchedProject(target, deps.watchedProjects());
  const tmux = new TmuxControl(deps.exec, deps.tmuxServer);
  switch (target.kind) {
    case 'slot': {
      const { sessions } = await resolveSlot(
        deps.exec,
        tmux,
        project,
        target.slot,
      );
      // Both `cs-<slot>` and `cs-<prefix>--<slot>` may be live: pick one, stably.
      const session = [...sessions].sort()[0];
      if (!session) throw notFound(`${target.slot} has no live session`);
      return session;
    }
    case 'orchestrator': {
      const fleet = await resolveFleetProject(deps.exec, project);
      const session = orchestratorSessionName(fleet.repo);
      if (!(await tmux.find(session))) {
        throw notFound(`the orchestrator of ${project.id} is not running`);
      }
      return session;
    }
    case 'skill_run':
      // Skill-run sessions (#24 D7) are not resolvable until #24's runner lands.
      throw new CommandFailure(
        'unsupported',
        'attaching to a skill run is not supported by this runner yet',
      );
  }
};
