import {
  CARD_CI_FIX_EFFORT,
  CARD_CI_FIX_MODEL,
  type CardEffort,
  type CardWorkClass,
  modelByType,
} from '@nautelle/shared';
import {
  type CardStartBranchSkip,
  cardBranchSchema,
  ORCHESTRATOR_DEFAULTS,
} from '@nautelle/shared/protocol';

/**
 * #322 D2: a card's model when nothing on the card overrides it — the
 * recommendation for the action, else the project's orchestrator model,
 * else the default.
 */
export const defaultCardModel = (
  recommended: string | null | undefined,
  projectModel: string | null | undefined,
): string => recommended ?? projectModel ?? ORCHESTRATOR_DEFAULTS.model;

/** #750 (ADR-0076): the technique key of the class mapping and the escalation. */
export const MODEL_BY_TYPE = 'model-by-type';

/**
 * #750 D3: the card's B arm of `model-by-type` — its class, `null` being
 * `unsure` (no, a failed, an out-of-contract or a stale assessment, D1).
 * Absent is the A arm.
 */
export interface CardModelByTypeArm {
  workClass: CardWorkClass | null;
}

/**
 * #663 (ADR-0068 §5): a round's default model and effort before the card's
 * overrides. A `ci_fix` round is mechanical: `sonnet` at `low`. Any other
 * takes the recommendation's model (D2) and effort; no effort is the CLI's
 * own default. #750 D3, D4: in the B arm of `model-by-type` the class
 * mapping replaces the recommendation's model, with the assessed effort.
 */
export const defaultCardLaunch = (
  ciFix: boolean,
  recommended: { model: string; effort: CardEffort | null } | null,
  projectModel: string | null | undefined,
  byType: CardModelByTypeArm | null = null,
): { model: string; effort: CardEffort | null } =>
  ciFix
    ? { model: CARD_CI_FIX_MODEL, effort: CARD_CI_FIX_EFFORT }
    : byType
      ? modelByType(byType.workClass, recommended?.effort ?? null, false)
      : {
          model: defaultCardModel(recommended?.model, projectModel),
          effort: recommended?.effort ?? null,
        };

/** #750 D8, D9: an Opus model — its alias or a full id. */
export const isOpusModel = (model: string): boolean => /opus/i.test(model);

/**
 * #322 D3: what a launch stores for a value the person sent. Nothing when
 * nothing was sent; `null` — follow the default again — when it equals what
 * D2 would have picked without the card's override; else the value.
 */
export const rememberedChoice = <T extends string>(
  sent: T | undefined,
  fallback: T | null,
): T | null | undefined =>
  sent === undefined ? undefined : sent === fallback ? null : sent;

/**
 * #854: why the API itself did not send a taken card's branch — not a card
 * branch (C-148: `card/`, `feat/`, `fix/`), a runner without
 * `cardStartBranch`, or the #359 D8 follow-up of a merged card.
 */
export type StartBranchApiSkip =
  | 'not_a_card_branch'
  | 'runner_outdated'
  | 'follow_up';

export type StartBranchChoice =
  | { kind: 'send'; branch: string }
  | { kind: 'skip'; reason: StartBranchApiSkip };

/**
 * #854 D1: whether a Run of a session-gone taken card sends its `takenBranch`
 * as `card.run`'s `startBranch`. `null` — nothing to choose: no taken branch,
 * or it is the card's branch already.
 */
export const startBranchChoice = (
  taken: string | null,
  branch: string,
  followUp: boolean,
  runnerTakesIt: boolean,
): StartBranchChoice | null => {
  if (taken === null || taken === branch) return null;
  if (followUp) return { kind: 'skip', reason: 'follow_up' };
  if (!cardBranchSchema.safeParse(taken).success) {
    return { kind: 'skip', reason: 'not_a_card_branch' };
  }
  if (!runnerTakesIt) return { kind: 'skip', reason: 'runner_outdated' };
  return { kind: 'send', branch: taken };
};

/** #854: the launch event's word on the taken branch — why it was not used. */
export const startBranchOutcome = (
  choice: StartBranchChoice | null,
  runnerSkip: CardStartBranchSkip | undefined,
): { startBranchSkipped?: StartBranchApiSkip | CardStartBranchSkip } =>
  choice?.kind === 'skip'
    ? { startBranchSkipped: choice.reason }
    : choice?.kind === 'send' && runnerSkip !== undefined
      ? { startBranchSkipped: runnerSkip }
      : {};
