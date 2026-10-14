import {
  type LocalCommandDeps,
  NotImplementedError,
} from '../local/subcommand';

/**
 * `agentdock-runner claude [-- <args>]` (spec 201 D23): `claude` in a
 * `agentdock-manual-<hex>` tmux session the browser can attach to. A stub
 * until the i201-manual-attach slot replaces this body; `cli.ts` already
 * routes here (every argument after `claude` arrives in `args`, verbatim).
 */
export const runClaude = async (
  _args: readonly string[],
  _deps: LocalCommandDeps,
): Promise<number> => {
  throw new NotImplementedError('claude');
};
