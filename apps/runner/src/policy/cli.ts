import { resolve } from 'node:path';
import {
  orchestratorPermissionModeSchema,
  POLICY_CODE_DENY_MAX,
  POLICY_GATED_COMMANDS,
  policyCodeDenySchema,
} from '@agentdock/shared/protocol';
import { loadConfig, saveConfig } from '../config';
import { EXIT } from '../service';
import { type Realpath, rootOutsideAllowed } from './roots';
import type { PolicyConfig } from './schema';
import { cachedRoots } from './upgrade';

export interface PolicyCliDeps {
  configFile: string;
  /** Relative directories resolve against it. */
  cwd: string;
  realpath: Realpath;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Asks a yes/no question on the terminal (`allow-root --watched`); Bun's
   * `confirm` in the CLI. Without it, only `--yes` goes ahead.
   */
  confirm?: (question: string) => boolean;
}

export const POLICY_USAGE = `Usage: agentdock-runner policy <command>

  show                         print the effective policy
  allow-root <dir>…            let projects under <dir> be watched
  allow-root --watched [--yes] allow the roots of the projects in the cached
                               watch list, after showing them and asking
                               (--yes skips the question)
  deny-root <dir>…             stop allowing <dir>
  deny-path <pattern>…         never let the assistant's code commands return
                               files matching <pattern> (a glob over paths in
                               a checkout; no "/" matches a name at any depth)
  allow-path <pattern>…        remove a deny-path pattern (secrets such as
                               .env* and key files stay refused)
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
 * `allow-root --watched` (#691): the roots of the cached watch list that the
 * policy does not allow yet, as real paths. The cache is what the runner
 * watched last, before an upgrade to 0.13 dropped it all.
 */
const watchedRoots = (
  config: ReturnType<typeof loadConfig>,
  deps: PolicyCliDeps,
): { root: string; ids: string[] }[] => {
  const found = new Map<string, string[]>();
  for (const root of cachedRoots(config.projects)) {
    const real = deps.realpath(root);
    if (real === null) {
      deps.stderr(`Skipped: ${root} does not exist on this machine.\n`);
      continue;
    }
    if (!rootOutsideAllowed(real, config.policy.allowedRoots, deps.realpath)) {
      continue;
    }
    const ids = config.projects.filter((p) => p.root === root).map((p) => p.id);
    found.set(real, [...(found.get(real) ?? []), ...ids]);
  }
  return [...found].map(([root, ids]) => ({ root, ids }));
};

const allowWatched = (
  config: ReturnType<typeof loadConfig>,
  flags: readonly string[],
  deps: PolicyCliDeps,
): PolicyConfig | 'nothing' | 'declined' => {
  const yes = flags.includes('--yes');
  if (flags.some((f) => f !== '--watched' && f !== '--yes')) {
    throw new PolicyUsageError('allow-root --watched takes only --yes');
  }
  const roots = watchedRoots(config, deps);
  if (roots.length === 0) {
    deps.stderr(
      config.projects.length === 0
        ? 'The cached watch list is empty: name the directories with `agentdock-runner policy allow-root <dir>`.\n'
        : 'Every root of the cached watch list is allowed already.\n',
    );
    return 'nothing';
  }
  deps.stderr(
    `These roots of the projects this runner watched will be allowed:\n${roots
      .map((r) => `  ${r.root} (${r.ids.join(', ')})\n`)
      .join('')}`,
  );
  if (!yes) {
    if (!deps.confirm) {
      throw new PolicyUsageError(
        'no terminal to ask on: pass --yes to allow them',
      );
    }
    if (!deps.confirm('Allow them?')) {
      deps.stderr('Nothing changed.\n');
      return 'declined';
    }
  }
  return {
    ...config.policy,
    allowedRoots: [
      ...new Set([...config.policy.allowedRoots, ...roots.map((r) => r.root)]),
    ],
  };
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
    } else if (verb === 'allow-root' && rest.includes('--watched')) {
      const allowed = allowWatched(config, rest, deps);
      if (allowed === 'nothing') return EXIT.ok;
      if (allowed === 'declined') return EXIT.failure;
      policy = allowed;
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
    } else if (verb === 'deny-path' && rest.length > 0) {
      const patterns = rest.map((pattern) => {
        const parsed = policyCodeDenySchema.safeParse(pattern);
        if (!parsed.success) {
          throw new PolicyUsageError(`not a path pattern: ${pattern}`);
        }
        return parsed.data;
      });
      const deny = [...new Set([...config.policy.code.deny, ...patterns])];
      if (deny.length > POLICY_CODE_DENY_MAX) {
        throw new PolicyUsageError(
          `at most ${POLICY_CODE_DENY_MAX} deny-path patterns`,
        );
      }
      policy = { ...config.policy, code: { deny } };
    } else if (verb === 'allow-path' && rest.length > 0) {
      const named = new Set(rest.map((pattern) => pattern.trim()));
      policy = {
        ...config.policy,
        code: { deny: config.policy.code.deny.filter((p) => !named.has(p)) },
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
