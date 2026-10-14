import type {
  CommandArgs,
  CommandResult,
  PlannerCommandName,
} from '@agentdock/shared/protocol';
import type { Logger } from '../log';
import type { SkillsDeps } from '../skills/deps';
import type { PlanTurnExecutor } from './executor';
import { publishSpecs } from './publish-specs';
import { queueIssues } from './queue-issues';

export { type PlanExecutorOptions, PlanTurnExecutor } from './executor';
export { type RunSlots, SharedRunSlots } from './slots';

/** The five `plan.*` handlers (docs/specs/172-planner.md "Protocol"). */
export type PlannerHandlers = {
  [N in PlannerCommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>> | CommandResult<N>;
};

export const createPlannerHandlers = (
  deps: SkillsDeps & { log: Logger },
  executor: PlanTurnExecutor,
): PlannerHandlers => ({
  'plan.turn': (args) => executor.run(args),
  'plan.cancel': (args) => executor.cancel(args),
  'plan.close': (args) => executor.close(args),
  'plan.publish_specs': (args) => publishSpecs(args, deps),
  'plan.queue_issues': (args) => queueIssues(args, deps),
});
