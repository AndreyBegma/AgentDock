import type {
  CommandArgs,
  CommandResult,
  SkillCommandName,
} from '@agentdock/shared/protocol';
import { SkillCatalog } from './catalog';
import type { SkillsDeps } from './deps';
import { inspectSkills, installSkill, uninstallSkill } from './install';
import { listSkills } from './inventory';
import type { SkillRunExecutor } from './run/executor';

export type { SkillsDeps } from './deps';
export { type ExecutorOptions, SkillRunExecutor } from './run/executor';
export { RunLogStreamer } from './run/log';

/** The seven `skill.*` handlers (spec 24). */
export type SkillHandlers = {
  [N in SkillCommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>> | CommandResult<N>;
};

export const createSkillHandlers = (
  deps: SkillsDeps & { fetch: typeof fetch },
  executor: SkillRunExecutor,
): SkillHandlers => {
  const catalog = new SkillCatalog({ fetch: deps.fetch, clock: deps.clock });
  return {
    'skill.search': (args) => catalog.search(args),
    'skill.inspect': (args) => inspectSkills(args, deps),
    'skill.install': (args) => installSkill(args, deps),
    'skill.uninstall': (args) => uninstallSkill(args, deps),
    'skill.list': (args) => listSkills(args, deps),
    'skill.run': (args) => executor.run(args),
    'skill.cancel': (args) => executor.cancel(args),
  };
};
