import {
  manualTmuxSessionSchema,
  orchestratorSessionName,
  type TerminalTarget,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { correlateCwd } from '../adapters/correlate';
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
  /**
   * The session of a running skill run of this project, or null
   * (`SkillRunExecutor.runSession`). Absent: skill runs are `unsupported`.
   */
  runSession?: (
    projectId: string,
    root: string,
    runId: string,
  ) => string | null;
  /**
   * The tmux session and cwd the daemon recorded for a Claude session from its
   * `SessionStart` hook (`HookSessions.manualOf`). Absent: `manual` targets
   * are `unsupported`.
   */
  manualSession?: (
    sessionId: string,
  ) => { tmuxSession: string; cwd: string } | undefined;
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
    case 'skill_run': {
      if (!deps.runSession) {
        throw new CommandFailure(
          'unsupported',
          'attaching to a skill run is not supported by this runner',
        );
      }
      // Only a running run of this very project (#24 D7); the executor checks
      // the project and root against the run's own record.
      const session = deps.runSession(project.id, project.root, target.runId);
      if (!session || !(await tmux.find(session))) {
        throw notFound(`run ${target.runId} of ${project.id} is not running`);
      }
      return session;
    }
    case 'manual': {
      if (!deps.manualSession) {
        throw new CommandFailure(
          'unsupported',
          'attaching to a manual session is not supported by this runner',
        );
      }
      // Only what a hook of this machine reported (D23), only an
      // `agentdock-manual-<hex>` name, and only one working inside this project.
      const known = deps.manualSession(target.sessionId);
      const name = manualTmuxSessionSchema.safeParse(known?.tmuxSession);
      if (!known || !name.success) {
        throw notFound(
          `session ${target.sessionId} has no manual tmux session`,
        );
      }
      if (correlateCwd(known.cwd, [project]).projectId !== project.id) {
        throw notFound(`session ${target.sessionId} is not in ${project.id}`);
      }
      if (!(await tmux.find(name.data))) {
        throw notFound(`session ${target.sessionId} is not running`);
      }
      return name.data;
    }
  }
};
