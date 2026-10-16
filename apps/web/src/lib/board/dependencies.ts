import {
  BOARD_ERROR,
  type BoardColumn,
  type CardDependencyRef,
  type CardReadiness,
  openDependencies,
} from '@agentdock/shared';
import { ApiError } from '../api';

/**
 * Card dependencies (#337 D8): "after C-12" on the face, the list in the
 * sheet, and the question Run asks when one is still open. They warn; they
 * never block a move or Accept.
 */

/** Labels the face names before it says "+n". */
const CHIP_LABELS_MAX = 2;

export interface DependencyChip {
  text: string;
  /** Some dependency is not in Completed: the chip warns. */
  open: boolean;
  /** Every dependency, for the chip's tooltip. */
  title: string;
}

/** The face's chip; null when the card depends on nothing. */
export function dependencyChip(
  dependsOn: readonly CardDependencyRef[] | undefined,
): DependencyChip | null {
  if (!dependsOn || dependsOn.length === 0) return null;
  const labels = dependsOn.map((d) => d.label);
  const shown = labels.slice(0, CHIP_LABELS_MAX).join(', ');
  const more = labels.length - CHIP_LABELS_MAX;
  const open = openDependencies(dependsOn);
  return {
    text: `after ${shown}${more > 0 ? ` +${more}` : ''}`,
    open: open.length > 0,
    title:
      open.length > 0
        ? `Runs after ${labels.join(', ')}. Not completed yet: ${open
            .map((d) => d.label)
            .join(', ')}.`
        : `Runs after ${labels.join(', ')}, all completed.`,
  };
}

/** "C-12 is not completed yet." / "C-12 and C-14 are not completed yet." */
export function openDependencyText(
  open: readonly Pick<CardDependencyRef, 'label'>[],
): string {
  const labels = open.map((d) => d.label);
  if (labels.length <= 1)
    return `${labels[0] ?? 'A dependency'} is not completed yet.`;
  const last = labels.at(-1);
  return `${labels.slice(0, -1).join(', ')} and ${last} are not completed yet.`;
}

const isRef = (value: unknown): value is CardDependencyRef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CardDependencyRef).number === 'number' &&
  typeof (value as CardDependencyRef).label === 'string' &&
  typeof (value as CardDependencyRef).column === 'string';

/**
 * The open dependencies of a Run refused with 409 `dependency_open`; null
 * for any other failure. A body without a readable list still counts — the
 * question is then asked without names.
 */
export function openDependenciesOf(error: unknown): CardDependencyRef[] | null {
  if (!(error instanceof ApiError)) return null;
  if (error.body?.error !== BOARD_ERROR.dependencyOpen) return null;
  const list = error.body.dependencies;
  return Array.isArray(list) ? list.filter(isRef) : [];
}

/** The sheet's add field: a card number, `12` or `C-12`; null when it is not one. */
export function parseCardNumber(raw: string): number | null {
  const match = /^\s*(?:c-?)?(\d{1,9})\s*$/i.exec(raw);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 ? n : null;
}

/** Whether a dependency still holds its dependant back. */
export const isOpenDependency = (column: BoardColumn): boolean =>
  column !== 'completed';

/** "C-84" / "C-84 and C-86" / "C-84, C-86 and C-90". */
const labelList = (refs: readonly Pick<CardDependencyRef, 'label'>[]) => {
  const labels = refs.map((d) => d.label);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
};

/** #443: the face's Ready / Waiting chip, and what a waiting card waits for. */
export interface ReadinessChip {
  text: string;
  tone: 'ok' | 'warn';
  title: string;
  /** "Waits for C-84"; null when the card is ready. */
  waitsFor: string | null;
}

/** #443: null for a card without readiness (not in To Do, or no dependency). */
export function readinessChip(
  readiness: CardReadiness | null | undefined,
): ReadinessChip | null {
  if (!readiness) return null;
  if (readiness.state === 'ready') {
    return {
      text: 'Ready',
      tone: 'ok',
      title: 'Every card it depends on is accepted.',
      waitsFor: null,
    };
  }
  const waitsFor = `Waits for ${labelList(readiness.open)}`;
  return {
    text: `Waiting · ${readiness.accepted} of ${readiness.total}`,
    tone: 'warn',
    title: `${waitsFor}. ${readiness.accepted} of ${readiness.total} accepted.`,
    waitsFor,
  };
}

/** #443: what Auto-run when ready will do, under its switch. */
export function autoRunNote(
  on: boolean,
  readiness: CardReadiness | null | undefined,
): string {
  if (!on) return 'Nothing starts on its own. Press Run when you are ready.';
  if (readiness?.state === 'waiting') {
    const open = readiness.open;
    return `Will start automatically after ${labelList(open)} ${open.length === 1 ? 'is' : 'are'} accepted.`;
  }
  return 'Nothing is left to wait for, so nothing will start it. Press Run.';
}
