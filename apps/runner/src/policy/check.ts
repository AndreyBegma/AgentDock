import {
  type CommandName,
  orchestratorPermissionModeSchema,
  type PolicyRule,
  permissionModeAllowed,
  policyAllowsCommand,
  policyFixHint,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import { notMainCheckout, type Realpath, rootOutsideAllowed } from './roots';
import type { PolicyConfig } from './schema';
import { shellWord } from './upgrade';

export interface PolicyRefusal {
  rule: PolicyRule;
  /** Why, in a sentence, with the CLI line that lifts it. */
  message: string;
}

/** A refusal of `rule`: why, then the CLI line that lifts it. */
export const policyRefusal = (
  rule: PolicyRule,
  why: string,
  detail?: string,
): PolicyRefusal => ({
  rule,
  message: `refused by this runner's policy (${rule}): ${why}. On the runner's machine: \`${policyFixHint(rule, detail)}\``,
});

/** The `policy_refused` failure a handler throws for `refusal`. */
export const policyFailure = (refusal: PolicyRefusal): CommandFailure =>
  new CommandFailure('policy_refused', refusal.message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every string under a `root` key, at any depth (`target.root` too). */
const rootsIn = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const item of value) rootsIn(item, found);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'root' && typeof item === 'string') found.push(item);
      else rootsIn(item, found);
    }
  }
  return found;
};

/** Why `root` may not be used, or null; `allowedRoots` refusals only. */
export const rootRefusal = (
  root: string,
  policy: PolicyConfig,
  realpath: Realpath,
): PolicyRefusal | null => {
  const why = rootOutsideAllowed(root, policy.allowedRoots, realpath);
  if (why === null) return null;
  // #691: the exact line for this root; a relative one gets the placeholder.
  return policyRefusal(
    'allowedRoots',
    why,
    root.startsWith('/') ? shellWord(root) : undefined,
  );
};

/** Why the policy refuses a launch in `mode`, or null. */
export const permissionModeRefusal = (
  name: string,
  mode: unknown,
  policy: PolicyConfig,
): PolicyRefusal | null => {
  const parsed = orchestratorPermissionModeSchema.safeParse(mode);
  if (!parsed.success) return null;
  if (permissionModeAllowed(parsed.data, policy.maxPermissionMode)) return null;
  return policyRefusal(
    'maxPermissionMode',
    `${name} asks for ${parsed.data}, this runner allows at most ${policy.maxPermissionMode}`,
    parsed.data,
  );
};

/**
 * ADR-0047: why the runner-local policy refuses this command, or null. Runs
 * on validated args, before any handler, whatever the server sent:
 * a gated command, a permission mode above the cap, a terminal write, a
 * profile skill install, a root (or `project.inspect` / `project.scan_rules`
 * path) outside
 * `allowedRoots`.
 */
export const commandRefusal = (
  name: CommandName,
  args: unknown,
  policy: PolicyConfig,
  realpath: Realpath,
): PolicyRefusal | null => {
  if (!policyAllowsCommand(policy, name)) {
    return policyRefusal('commands', `${name} is off on this runner`, name);
  }
  if (!isRecord(args)) return null;
  const mode = permissionModeRefusal(name, args.permissionMode, policy);
  if (mode) return mode;
  if (name === 'terminal.attach' && args.mode === 'write') {
    if (!policy.terminal.write) {
      return policyRefusal(
        'terminal.write',
        'a write attach is off on this runner',
      );
    }
  }
  if (
    name === 'skill.install' &&
    isRecord(args.target) &&
    args.target.scope === 'profile' &&
    !policy.skills.profileInstall
  ) {
    return policyRefusal(
      'skills.profileInstall',
      'installing a skill into a Claude profile is off on this runner',
    );
  }
  const roots = rootsIn(args);
  if (
    (name === 'project.inspect' || name === 'project.scan_rules') &&
    typeof args.path === 'string'
  ) {
    roots.push(args.path);
  }
  for (const root of roots) {
    const outside = rootRefusal(root, policy, realpath);
    if (outside) return outside;
  }
  return null;
};

/**
 * ADR-0047: why a watch-list root from the server is refused, or null — an
 * absolute path whose real path is inside `allowedRoots` and is a git main
 * checkout.
 */
export const watchedRootRefusal = async (
  root: string,
  policy: PolicyConfig,
  exec: Exec,
  realpath: Realpath,
): Promise<string | null> => {
  const outside = rootRefusal(root, policy, realpath);
  if (outside) return outside.message;
  const why = await notMainCheckout(exec, root, realpath);
  return why === null ? null : policyRefusal('allowedRoots', why).message;
};
