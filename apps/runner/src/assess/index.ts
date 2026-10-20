import type {
  AssessCommandName,
  CommandArgs,
  CommandResult,
} from '@nautelle/shared/protocol';
import type { AssessExecutor } from './executor';

export {
  AssessExecutor,
  type AssessExecutorOptions,
} from './executor';

/** The one `card.assess` handler (issue #322 D5). */
export type AssessHandlers = {
  [N in AssessCommandName]: (args: CommandArgs<N>) => Promise<CommandResult<N>>;
};

export const createAssessHandlers = (
  executor: AssessExecutor,
): AssessHandlers => ({
  'card.assess': (args) => executor.run(args),
});
