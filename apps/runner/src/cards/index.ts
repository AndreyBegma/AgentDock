import type {
  CardCommandName,
  CommandArgs,
  CommandResult,
} from '@agentdock/shared/protocol';
import type { CardExecutor } from './executor';

export { CardExecutor, type CardExecutorOptions } from './executor';
export { type CardMergeDeps, mergeCard } from './merge';

/**
 * The executor's `card.*` handlers (issue #242 "Runner"). `card.merge`
 * (#273) holds no card state — no worktree, no tmux — so `createHandlers`
 * serves it with `mergeCard` beside these, for a runner that runs cards.
 */
export type CardHandlers = {
  [N in Exclude<CardCommandName, 'card.merge'>]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>>;
};

export const createCardHandlers = (executor: CardExecutor): CardHandlers => ({
  'card.run': (args) => executor.run(args),
  'card.stop': (args) => executor.stopCard(args),
  'card.collect': (args) => executor.collect(args),
  'card.close': (args) => executor.close(args),
});
