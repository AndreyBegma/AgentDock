import { resolve } from 'node:path';
import {
  orchestratorPermissionModeSchema,
  POLICY_GATED_COMMANDS,
} from '@agentdock/shared/protocol';
import { loadConfig, saveConfig } from '../config';
import { EXIT } from '../service';
import { type Realpath, rootOutsideAllowed } from './roots';
import type { PolicyConfig } from './schema';

export interface PolicyCliDeps {
  configFile: string;
  /** Relative directories resolve against it. */
  cwd: string;
  realpath: Realpath;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const POLICY_USAGE = `Usage: agentdock-runner policy <command>

  show                         print the effective policy
  allow-root <dir>…            let projects under <dir> be watched
  deny-root <dir>…             stop allowing <dir>
  set <key> <value>            change one rule:
        maxPermissionMode manual|acceptEdits|auto|bypassPermissions
        terminal.write true|false
        skills.profileInstall true|false
        commands.<name> true|false   (${POLICY_GATED_COMMANDS.join(', ')})

The policy lives in runner.json and only this command changes it; the server
cannot. A running daemon picks a change up within seconds.
`;

class PolicyUsageError extends Error {}

const parseBoolean = (key: string, value: string): boolean => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new PolicyUsageError(`${key} takes true or false, not ${value}`);
};

/** `set <key> <value>` applied to `policy`; a usage error for anything else. */
export const setPolicyKey = (
  policy: PolicyConfig,
  key: string,
  value: string,
): PolicyConfig => {
  if (key === 'maxPermissionMode') {
    const mode = orchestratorPermissionModeSchema.safeParse(value);
    if (!mode.success) {
      throw new PolicyUsageError(
        `maxPermissionMode takes ${orchestratorPermissionModeSchema.options.join(', ')}`,
      );
    }
    return { ...policy, maxPermissionMode: mode.data };
  }
  if (key === 'terminal.write') {
    return { ...policy, terminal: { write: parseBoolean(key, value) } };
  }
  if (key === 'skills.profileInstall') {
    return {
      ...policy,
      skills: { profileInstall: parseBoolean(key, value) },
    };
  }
  if (key.startsWith('commands.')) {
    const name = key.slice('commands.'.length);
    const gated = POLICY_GATED_COMMANDS.find((c) => c === name);
    if (!gated) {
      throw new PolicyUsageError(
        `commands.<name> is one of ${POLICY_GATED_COMMANDS.join(', ')}`,
      );
    }
    return {
      ...policy,
      commands: { ...policy.commands, [gated]: parseBoolean(key, value) },
    };
  }
  throw new PolicyUsageError(`unknown policy key: ${key}`);
};

/** Real, absolute directories for `dirs`; a usage error when one is missing. */
export const realRoots = (
  dirs: readonly string[],
  deps: Pick<PolicyCliDeps, 'cwd' | 'realpath'>,
): string[] =>
  dirs.map((dir) => {
    const real = deps.realpath(resolve(deps.cwd, dir));
    if (real === null) throw new PolicyUsageError(`${dir} does not exist`);
    return real;
  });

const showPolicy = (deps: PolicyCliDeps): void => {
  const config = loadConfig(deps.configFile);
  const { policy } = config;
  deps.stdout(`${JSON.stringify(policy, null, 2)}\n`);
  if (policy.allowedRoots.length === 0) {
    deps.stderr(
      'No root is allowed: no project is watched. Add one with `agentdock-runner policy allow-root <dir>`.\n',
    );
  }
  const outside = config.projects.filter((p) =>
    rootOutsideAllowed(p.root, policy.allowedRoots, deps.realpath),
  );
  for (const p of outside) {
    deps.stderr(`Not watched: ${p.root} (${p.id}) is outside allowedRoots.\n`);
  }
};

/**
 * `agentdock-runner policy …` (ADR-0047): the one writer of the policy. It
 * rewrites `runner.json` with only the policy changed.
 */
export const runPolicy = (
  args: readonly string[],
  deps: PolicyCliDeps,
): number => {
  const [verb, ...rest] = args;
  try {
    if (verb === 'show' && rest.length === 0) {
      showPolicy(deps);
      return EXIT.ok;
    }
    const config = loadConfig(deps.configFile);
    let policy: PolicyConfig;
    if (verb === 'set' && rest.length === 2) {
      policy = setPolicyKey(config.policy, rest[0], rest[1]);
    } else if (verb === 'allow-root' && rest.length > 0) {
      const roots = realRoots(rest, deps);
      policy = {
        ...config.policy,
        allowedRoots: [...new Set([...config.policy.allowedRoots, ...roots])],
      };
    } else if (verb === 'deny-root' && rest.length > 0) {
      const named = new Set(rest.map((dir) => resolve(deps.cwd, dir)));
      for (const dir of [...named]) {
        const real = deps.realpath(dir);
        if (real) named.add(real);
      }
      policy = {
        ...config.policy,
        allowedRoots: config.policy.allowedRoots.filter((r) => !named.has(r)),
      };
    } else {
      throw new PolicyUsageError(
        verb ? `unknown or incomplete: policy ${args.join(' ')}` : '',
      );
    }
    saveConfig(deps.configFile, { ...config, policy });
    deps.stdout(`${JSON.stringify(policy, null, 2)}\n`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof PolicyUsageError) {
      deps.stderr(
        error.message ? `${error.message}\n\n${POLICY_USAGE}` : POLICY_USAGE,
      );
      return EXIT.usage;
    }
    throw error;
  }
};
