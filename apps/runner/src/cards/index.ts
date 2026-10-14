import type {
  CardCommandName,
  CommandArgs,
  CommandResult,
} from '@agentdock/shared/protocol';
import type { CardExecutor } from './executor';

export { CardExecutor, type CardExecutorOptions } from './executor';

/** The four `card.*` handlers (issue #242 "Runner"). */
export type CardHandlers = {
  [N in CardCommandName]: (args: CommandArgs<N>) => Promise<CommandResult<N>>;
};

export const createCardHandlers = (executor: CardExecutor): CardHandlers => ({
  'card.run': (args) => executor.run(args),
  'card.stop': (args) => executor.stopCard(args),
  'card.collect': (args) => executor.collect(args),
  'card.close': (args) => executor.close(args),
});
