import type {
  CaptureCommandName,
  CommandArgs,
  CommandResult,
} from '@nautelle/shared/protocol';
import type { CaptureExecutor } from './executor';

export {
  CAPTURE_CLAUDE_FLAGS,
  CaptureExecutor,
  type CaptureExecutorOptions,
  type CaptureProcess,
  type CaptureSpawn,
} from './executor';

/** The one `cards.extract` handler (issue #244 "Runner"). */
export type CaptureHandlers = {
  [N in CaptureCommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>>;
};

export const createCaptureHandlers = (
  executor: CaptureExecutor,
): CaptureHandlers => ({
  'cards.extract': (args) => executor.run(args),
});
