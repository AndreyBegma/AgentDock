import type {
  PlanTaskVersionsView,
  PlanTaskVersionView,
  PlanVersionTurnView,
} from '@agentdock/shared';
import { TURN_ACTION_LABEL } from './format';

/** "Revise the plan · Ada": what produced a version, and who asked for it. */
export const versionTurnText = (turn: PlanVersionTurnView | null): string =>
  turn
    ? `${TURN_ACTION_LABEL[turn.action]} · ${turn.author.name}`
    : 'Producing turn unknown';

/**
 * The version to show: the one picked, while the list still holds it; else
 * the newest the task appeared in — the current one, or the version a
 * rejected task was dropped after.
 */
export const shownVersion = (
  view: PlanTaskVersionsView,
  picked: number | null,
): PlanTaskVersionView | undefined =>
  view.versions.find((v) => v.version === picked) ?? view.versions.at(-1);
