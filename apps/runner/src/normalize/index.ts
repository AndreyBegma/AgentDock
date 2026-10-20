import type {
  CommandArgs,
  CommandResult,
  TextCommandName,
} from '@nautelle/shared/protocol';
import type { NormalizeExecutor } from './executor';

export {
  NormalizeExecutor,
  type NormalizeExecutorOptions,
} from './executor';

/** The one `text.normalize` handler (issue #271 "Runner"). */
export type NormalizeHandlers = {
  [N in TextCommandName]: (args: CommandArgs<N>) => Promise<CommandResult<N>>;
};

export const createNormalizeHandlers = (
  executor: NormalizeExecutor,
): NormalizeHandlers => ({
  'text.normalize': (args) => executor.run(args),
});
