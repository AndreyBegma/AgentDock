import type { CardPrState } from '@prisma/client';

/** #640: a dependency of a card as the choice of its start reads it. */
export interface StartDependency {
  number: number;
  branch: string | null;
  prNumber: number | null;
  prState: CardPrState | null;
  mergedAt: Date | null;
}

/** #640 (ADR-0064): what a card's round 1 creates its branch from. */
export interface CardStart {
  /** The project's base, or the one unmerged dependency's branch. */
  base: string;
  /** The dependency whose branch `base` is; `null` for the project's base. */
  card: number | null;
  /** Unmerged dependencies whose code the branch will not have, ascending. */
  missing: { number: number; branch: string }[];
}

/**
 * #640: a dependency whose pull request is open and not seen merged — it has
 * a branch other than the base and a PR, the PR is not `merged` and the card
 * has no `mergedAt`. A `closed` PR is abandoned work, not pending code: it is
 * neither a start nor missing. An unknown state (`null`) counts as open.
 */
export const unmergedDependencies = (
  dependencies: readonly StartDependency[],
  projectBase: string,
): { number: number; branch: string }[] =>
  dependencies
    .filter(
      (d): d is StartDependency & { branch: string } =>
        d.branch !== null &&
        d.branch !== projectBase &&
        d.prNumber !== null &&
        d.mergedAt === null &&
        d.prState !== 'merged' &&
        d.prState !== 'closed',
    )
    .map((d) => ({ number: d.number, branch: d.branch }))
    .sort((a, b) => a.number - b.number);

/**
 * #640 (ADR-0064): exactly one unmerged dependency — its branch, when the
 * runner can start from one (`canStartFrom`); none — the project's base;
 * two or more — the project's base, and they are the missing ones. A runner
 * that cannot start from a branch leaves the one dependency missing too.
 */
export const chooseCardStart = (
  dependencies: readonly StartDependency[],
  projectBase: string,
  canStartFrom: boolean,
): CardStart => {
  const unmerged = unmergedDependencies(dependencies, projectBase);
  const [only] = unmerged;
  if (only && unmerged.length === 1 && canStartFrom) {
    return { base: only.branch, card: only.number, missing: [] };
  }
  return { base: projectBase, card: null, missing: unmerged };
};
