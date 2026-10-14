import {
  type LocalCommandDeps,
  NotImplementedError,
} from '../local/subcommand';

/**
 * `agentdock-runner mcp` (spec 201 D20): the `agentdock` MCP server over
 * stdio, built on `local/client.ts`. A stub until the i201-runner-mcp slot
 * replaces this body; `cli.ts` already routes here and stays untouched.
 */
export const runMcp = async (
  _args: readonly string[],
  _deps: LocalCommandDeps,
): Promise<number> => {
  throw new NotImplementedError('mcp');
};
