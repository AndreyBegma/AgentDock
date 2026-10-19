import type { CardDependencyRef, CardReadiness } from './contracts';
import type { BoardColumn } from './types';

/**
 * Card dependencies (#337 D8): `cardId` runs after `dependsOnId`. The graph
 * stays acyclic — checked on insert — and Run refuses while a dependency is
 * open, with no override (#638, ADR-0063).
 */

export interface CardDependencyEdge {
  cardId: string;
  dependsOnId: string;
}

/**
 * The cycle adding `cardId → dependsOnId` to `edges` would close, as the card
 * ids along it from `cardId` back to `cardId`; null when it closes none. A
 * card depending on itself is the one-card cycle.
 */
export const findDependencyCycle = (
  edges: readonly CardDependencyEdge[],
  cardId: string,
  dependsOnId: string,
): string[] | null => {
  if (cardId === dependsOnId) return [cardId, cardId];
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.cardId);
    if (list) list.push(e.dependsOnId);
    else next.set(e.cardId, [e.dependsOnId]);
  }
  // A path dependsOnId → … → cardId closes the cycle.
  const from = new Map<string, string>();
  const queue = [dependsOnId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (at === cardId) {
      const path = [cardId];
      let step = cardId;
      while (step !== dependsOnId) {
        step = from.get(step) as string;
        path.push(step);
      }
      return [cardId, ...path.reverse()];
    }
    for (const to of next.get(at) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      from.set(to, at);
      queue.push(to);
    }
  }
  return null;
};

/**
 * #638 (ADR-0063): a dependency is satisfied once its pull request is ready
 * (Finished) or it is accepted (Completed). Leaving both opens it again.
 */
export const DEPENDENCY_SATISFIED_COLUMNS = [
  'finished',
  'completed',
] as const satisfies readonly BoardColumn[];

export const isDependencySatisfied = (column: BoardColumn): boolean =>
  (DEPENDENCY_SATISFIED_COLUMNS as readonly BoardColumn[]).includes(column);

/** The dependencies that hold Run back: every one not satisfied. */
export const openDependencies = <T extends Pick<CardDependencyRef, 'column'>>(
  dependencies: readonly T[],
): T[] => dependencies.filter((d) => !isDependencySatisfied(d.column));

/**
 * #443: Ready / Waiting — only a card in To Do with at least one dependency
 * has it; ready once every dependency is satisfied (#638).
 */
export const cardReadiness = (
  column: BoardColumn,
  dependencies: readonly CardDependencyRef[],
): CardReadiness | null => {
  if (column !== 'todo' || dependencies.length === 0) return null;
  const open = openDependencies(dependencies);
  return {
    state: open.length === 0 ? 'ready' : 'waiting',
    satisfied: dependencies.length - open.length,
    total: dependencies.length,
    open,
  };
};
