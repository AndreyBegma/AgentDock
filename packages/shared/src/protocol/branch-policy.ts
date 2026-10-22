import { z } from 'zod';
import { gitRefSchema } from './commands/skills';

/**
 * C-148 (ADR-0077): the branches a runner pushes for a card start with one
 * of these. `card/c<n>-<slug>` is a card without an issue, `feat/` and `fix/`
 * one linked to an issue (`cardBranch`, #201 D14). A skill run's branch is
 * `run/<shortid>-<skill>` (`skillRunBranch`), made by the runner itself.
 */
export const CARD_BRANCH_PREFIXES = ['card/', 'feat/', 'fix/'] as const;

export const hasCardBranchPrefix = (branch: string): boolean =>
  CARD_BRANCH_PREFIXES.some(
    (prefix) => branch.startsWith(prefix) && branch.length > prefix.length,
  );

/** A card branch: a git ref with a `CARD_BRANCH_PREFIXES` prefix, never `main`. */
export const cardBranchSchema = gitRefSchema.refine(hasCardBranchPrefix, {
  message: `must start with ${CARD_BRANCH_PREFIXES.join(', ')}`,
});

/**
 * C-148 (D-12, ADR-0077): the paths whose change a person reviews — CI,
 * deployment, the images it builds (C-182) and the released plugins. A directory ends in `/`; anything
 * else is one file at the repository's root. Fixed here, not read from the
 * repository, so a branch cannot shorten the list it is checked against.
 */
export const PROTECTED_PATHS = [
  '.github/',
  '.woodpecker/',
  '.woodpecker.yml',
  '.woodpecker.yaml',
  'deploy/',
  'plugins/',
  '.claude-plugin/',
  'docker/',
] as const;

/** Whether a repository-relative path is under `PROTECTED_PATHS`. */
export const isProtectedPath = (path: string): boolean =>
  PROTECTED_PATHS.some((p) =>
    p.endsWith('/') ? path.startsWith(p) : path === p,
  );

/** At most this many protected paths are reported; the rest are dropped. */
export const PROTECTED_PATHS_MAX = 100;

/**
 * The protected paths a pushed branch changes against its base. Empty: none.
 * Absent from a runner older than C-148: unknown.
 */
export const protectedPathsSchema = z
  .array(z.string().min(1).max(4096))
  .max(PROTECTED_PATHS_MAX);
