import type {
  CommandArgs,
  CommandResult,
  PrefixCommandName,
} from '@nautelle/shared/protocol';
import type { PrefixCalls } from './calls';

export { PrefixCalls, type PrefixCallsOptions } from './calls';

/** The launch prefix's commands (docs/specs/751 B6, B8). */
export type PrefixHandlers = {
  [N in PrefixCommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>> | CommandResult<N>;
};

export const createPrefixHandlers = (calls: PrefixCalls): PrefixHandlers => ({
  'rules.compress': (args) => calls.compress(args),
  'prefix.propose': (args) => calls.propose(args),
});
