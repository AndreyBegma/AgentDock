import { saveConfig } from '../config';
import type { Exec } from '../detect/exec';
import type { Realpath } from './roots';
import { type PolicyConfig, policyConfigSchema } from './schema';

/** A policy that refuses nothing: tests of the commands themselves use it. */
export const permissivePolicy = (): PolicyConfig =>
  policyConfigSchema.parse({
    allowedRoots: ['/'],
    maxPermissionMode: 'bypassPermissions',
    terminal: { write: true },
    skills: { profileInstall: true },
    commands: {
      'orchestrator.message': true,
      'slot.message': true,
      'session.message': true,
    },
  });

/** Every path is its own real path, existing or not: for fixture paths. */
export const sameRealpath: Realpath = (path) => path;

/**
 * `exec` that also answers `git rev-parse` for `roots` as git main checkouts,
 * so a watch list of fixture roots passes the policy.
 */
export const withMainCheckouts =
  (exec: Exec, roots: readonly string[]): Exec =>
  async (binary, args, options) => {
    const [, root, verb] = args;
    if (binary === 'git' && args[0] === '-C' && verb === 'rev-parse') {
      if (roots.includes(root) && args.includes('--git-common-dir')) {
        return { code: 0, stdout: `${root}/.git\n${root}\n`, stderr: '' };
      }
    }
    return exec(binary, args, options);
  };

/** Writes a `runner.json` holding only `policy`, as the CLI would. */
export const writePolicy = (
  configFile: string,
  policy: PolicyConfig = permissivePolicy(),
): void => saveConfig(configFile, { policy });
