import type {
  CardCommandName,
  CardReviewCommandName,
  CommandArgs,
  CommandResult,
} from '@nautelle/shared/protocol';
import type { CardExecutor } from './executor';

export { type CardChecksDeps, cardChecks } from './checks';
export { type CardCiRetriggerDeps, retriggerCardCi } from './ci-retrigger';
export { CardExecutor, type CardExecutorOptions } from './executor';
export { type CardMergeDeps, mergeCard } from './merge';
export { type CardPrCloseDeps, closeCardPr } from './pr-close';
export { type CardPrOpenDeps, openCardPr } from './pr-open';
export { type CardPrRetargetDeps, retargetCardPr } from './pr-retarget';
export {
  type CardReviewPublishDeps,
  publishCardReview,
} from './review-publish';

/**
 * The executor's `card.*` handlers (issue #242 "Runner"). `card.merge`
 * (#273) holds no card state — no worktree, no tmux — so `createHandlers`
 * serves it with `mergeCard` beside these, for a runner that runs cards;
 * `card.prClose` (#329 D8) likewise with `closeCardPr`, and `card.checks`
 * (#359 D5) with `cardChecks`, `card.ciRetrigger` (#484) with
 * `retriggerCardCi`, `card.prRetarget` (#636) with `retargetCardPr`, and
 * `card.prOpen` (#709) with `openCardPr`, and `card.reviewPublish` (#884)
 * with `publishCardReview`. `card.review` and `card.reviewStop` (#884) are
 * the executor's: they share its tmux and its card store.
 */
export type CardHandlers = {
  [N in
    | Exclude<CardCommandName, 'card.merge'>
    | Exclude<CardReviewCommandName, 'card.reviewPublish'>]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>>;
};

export const createCardHandlers = (executor: CardExecutor): CardHandlers => ({
  'card.run': (args) => executor.run(args),
  'card.stop': (args) => executor.stopCard(args),
  'card.collect': (args) => executor.collect(args),
  'card.close': (args) => executor.close(args),
  'card.review': (args) => executor.review(args),
  'card.reviewStop': (args) => executor.stopReview(args),
});
