import { localRequest } from './client';
import type { LocalCommandDeps } from './subcommand';

/**
 * `agentdock-runner away on|off` (spec 201 D17): sets the runner's away mode
 * through the daemon (`away.set`). Exit 0 on success, 1 when the daemon or
 * the server refused, 2 on a usage error.
 */
export const runAway = async (
  args: readonly string[],
  deps: LocalCommandDeps,
): Promise<number> => {
  const [value, ...rest] = args;
  if ((value !== 'on' && value !== 'off') || rest.length > 0) {
    deps.stderr('Usage: agentdock-runner away on|off\n');
    return 2;
  }
  const result = await localRequest(
    deps.socketPath,
    'away.set',
    { on: value === 'on' },
    { via: 'cli', cwd: deps.cwd },
  );
  if (!result.ok) {
    const { code, message } = result.error;
    deps.stderr(
      `Cannot set away mode: ${code}${message ? ` — ${message}` : ''}\n`,
    );
    return 1;
  }
  deps.stdout(`Away mode ${result.data.awayMode ? 'on' : 'off'}.\n`);
  return 0;
};
