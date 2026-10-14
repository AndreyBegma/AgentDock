import type {
  CommandArgs,
  CommandResult,
  UiProfileCommandName,
} from '@agentdock/shared/protocol';
import type { SkillsDeps } from '../skills/deps';
import type { UiProfileBuildExecutor } from './executor';
import { fingerprint } from './fingerprint';

export {
  UIPROFILE_TICK_MS,
  UiProfileBuildExecutor,
  type UiProfileExecutorOptions,
} from './executor';

/** The two `uiprofile.*` handlers (docs/specs/223-design-stage.md "Protocol"). */
export type UiProfileHandlers = {
  [N in UiProfileCommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>> | CommandResult<N>;
};

export const createUiProfileHandlers = (
  deps: Pick<SkillsDeps, 'exec' | 'watchedProjects'>,
  executor: UiProfileBuildExecutor,
): UiProfileHandlers => ({
  'uiprofile.build': (args) => executor.run(args),
  'uiprofile.fingerprint': (args) => fingerprint(args, deps),
});
