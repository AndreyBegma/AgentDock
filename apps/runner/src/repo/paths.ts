import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import type { WatchedProject } from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import { policyFailure, policyRefusal } from '../policy/check';
import type { PolicyConfig } from '../policy/schema';

/**
 * Names the code commands never return, whatever the policy says (#622): env
 * files, private keys and key stores, credential files, and the directories
 * that hold them — `.git` too, whose config may carry a token. Each is a
 * glob over one path segment, matched lowercased, at any depth.
 */
export const SECRET_NAME_GLOBS = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p8',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.ppk',
  '*.kdbx',
  '*.gpg',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  'credentials',
  'credentials.json',
  'credentials.yml',
  'credentials.yaml',
  'credentials.toml',
  'credentials.ini',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
  '.git',
  '.ssh',
  '.gnupg',
  '.aws',
] as const;

const globCache = new Map<string, Bun.Glob>();
const glob = (pattern: string): Bun.Glob => {
  let compiled = globCache.get(pattern);
  if (!compiled) {
    compiled = new Bun.Glob(pattern);
    globCache.set(pattern, compiled);
  }
  return compiled;
};

const segmentsOf = (rel: string): string[] =>
  rel.split('/').filter((s) => s !== '');

/** Whether a segment of `rel` (a file or a directory above it) is a secret. */
export const isSecretPath = (rel: string): boolean =>
  segmentsOf(rel).some((segment) => {
    const name = segment.toLowerCase();
    return SECRET_NAME_GLOBS.some((g) => glob(g).match(name));
  });

/**
 * The `code.deny` pattern that matches `rel`, or null. A pattern without `/`
 * matches a segment at any depth; one with `/` matches the path, or a
 * directory above it, from the checkout's top (a leading `/` is dropped).
 */
export const deniedBy = (
  rel: string,
  deny: readonly string[],
): string | null => {
  const segments = segmentsOf(rel);
  for (const raw of deny) {
    const pattern = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    if (pattern === '') continue;
    if (!pattern.includes('/')) {
      if (segments.some((s) => glob(pattern).match(s))) return raw;
      continue;
    }
    for (let n = 1; n <= segments.length; n++) {
      if (glob(pattern).match(segments.slice(0, n).join('/'))) return raw;
    }
  }
  return null;
};

/** Why `rel` may not be returned, or null: a secret, then a policy pattern. */
export const withheldReason = (
  rel: string,
  policy: PolicyConfig,
): 'secret' | 'denied' | null => {
  if (isSecretPath(rel)) return 'secret';
  return deniedBy(rel, policy.code.deny) === null ? null : 'denied';
};

/** Throws the failure for a withheld `rel`: `path_not_allowed` or `policy_refused`. */
export const assertReadable = (rel: string, policy: PolicyConfig): void => {
  if (isSecretPath(rel)) {
    throw new CommandFailure(
      'path_not_allowed',
      `${rel} is a secret file; the runner never returns it`,
    );
  }
  const pattern = deniedBy(rel, policy.code.deny);
  if (pattern !== null) {
    throw policyFailure(
      policyRefusal(
        'code.deny',
        `${rel} matches the deny-path pattern ${pattern}`,
        pattern,
      ),
    );
  }
};

const isWithin = (child: string, dir: string): boolean => {
  const rel = relative(dir, child);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
};

export interface CheckoutPath {
  /** The checkout's real top level. */
  root: string;
  /** `path` relative to it, `/`-separated, normalized; '' for the top. */
  rel: string;
}

/**
 * #622: the watched project's checkout and `path` inside it, or a failure.
 * - `projectId` and `root` must be one watch-list entry;
 * - `path` must be relative, and stay inside after normalization — `..`
 *   that climbs out is refused before the filesystem is touched;
 * - its real path (every symlink resolved) must still be inside, and must
 *   not be a secret or denied — so a symlink to `.env` is refused too;
 * - the name as given must not be a secret or denied either.
 */
export const checkoutPath = (
  args: { projectId: string; root: string; path?: string },
  watched: readonly WatchedProject[],
  policy: PolicyConfig,
): CheckoutPath => {
  const project = watchedProject(args, watched);
  let root: string;
  try {
    root = realpathSync(project.root);
  } catch {
    throw new CommandFailure('path_not_found', `${project.root} is missing`);
  }
  const given = (args.path ?? '').replace(/\\/g, '/');
  if (given.startsWith('/') || isAbsolute(given)) {
    throw new CommandFailure(
      'path_not_allowed',
      `${given} is absolute; give a path relative to the checkout`,
    );
  }
  const normalized = posix.normalize(given === '' ? '.' : given);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new CommandFailure(
      'path_not_allowed',
      `${given} is outside the checkout`,
    );
  }
  const rel = normalized === '.' ? '' : normalized.replace(/\/+$/, '');
  if (rel !== '') assertReadable(rel, policy);
  const full = join(root, rel);
  let real: string;
  try {
    lstatSync(full);
    real = realpathSync(full);
  } catch {
    throw new CommandFailure('path_not_found', `${rel} does not exist`);
  }
  if (!isWithin(real, root)) {
    throw new CommandFailure(
      'path_not_allowed',
      `${rel} resolves outside the checkout`,
    );
  }
  const realRel = relative(root, real).split(sep).join('/');
  if (realRel !== '' && realRel !== rel) assertReadable(realRel, policy);
  return { root, rel };
};
