import type {
  CommandArgs,
  CommandResult,
  RepoCommandName,
} from '@agentdock/shared/protocol';
import type { CodeAsker } from './ask';
import { repoRead } from './read';
import { repoSearch } from './search';
import type { RepoDeps } from './types';

export { CodeAsker } from './ask';

/** `repo.search`, `repo.read` and `code.ask` (#622, ADR-0063). */
export type RepoHandlers = {
  [N in RepoCommandName]: (args: CommandArgs<N>) => Promise<CommandResult<N>>;
};

export const createRepoHandlers = (
  deps: RepoDeps,
  asker: CodeAsker,
): RepoHandlers => ({
  'repo.search': (args) => repoSearch(args, deps),
  'repo.read': (args) => repoRead(args, deps),
  'code.ask': (args) => asker.ask(args),
});
