import type {
  DiscussProposal,
  PlanDetail,
  PlanSummary,
  PlanTurnView,
} from '@agentdock/shared';
import { formatRelative, pluralize } from '../format';
import { activeTurn, isActiveTurn } from '../planner/format';

/**
 * A discussion (#590, ADR-0056): a `discuss`-mode plan — the person asks
 * about the code or for an analysis, the planner replies, maybe with cards
 * worth making. No round limit and no required result. These helpers say
 * what its dialog shows and where it stands on the Drafts strip.
 */

/** The opening question, as typed: the API's brief limit. */
export const DISCUSS_OPENING_MAX = 20_000;
/** A later message: the turn input's limit (`PLANNER_SUMMARY_MAX`). */
export const DISCUSS_MESSAGE_MAX = 4_000;

/** One entry of the thread, oldest first. */
export type DiscussEntry =
  /** The person's words: the opening, or a turn's message. */
  | { kind: 'person'; id: string; author: string; text: string; at: string }
  /** The planner's reply, with the cards it proposes. */
  | {
      kind: 'reply';
      id: string;
      turn: PlanTurnView;
      reply: string;
      proposals: DiscussProposal[];
      at: string;
    }
  /** An earlier turn that got no reply — it failed or was cancelled. */
  | { kind: 'unanswered'; id: string; turn: PlanTurnView };

const ended = (turn: PlanTurnView): boolean =>
  turn.phase === 'failed' || turn.phase === 'cancelled';

/**
 * The thread: the opening, then each turn's message and reply. A turn that
 * ended without a reply and was asked again with the same words (Retry) is
 * left out, so a retried question reads once; one that was left behind says
 * it got no reply. The turn in flight and the failed newest turn are the
 * dialog's own states, below the thread.
 */
export function discussionEntries(plan: PlanDetail): DiscussEntry[] {
  const entries: DiscussEntry[] = [
    {
      kind: 'person',
      id: `${plan.id}-opening`,
      author: plan.author.name,
      text: plan.brief,
      at: plan.createdAt,
    },
  ];
  const turns = plan.turns.filter((t) => t.action === 'discuss');
  turns.forEach((turn, i) => {
    const next = turns[i + 1];
    if (ended(turn) && next && next.input.message === turn.input.message) {
      return;
    }
    if (turn.input.message) {
      entries.push({
        kind: 'person',
        id: `${turn.id}-message`,
        author: turn.author.name,
        text: turn.input.message,
        at: turn.createdAt,
      });
    }
    if (turn.reply) {
      entries.push({
        kind: 'reply',
        id: turn.id,
        turn,
        reply: turn.reply.reply,
        proposals: turn.reply.proposals,
        at: turn.finishedAt ?? turn.createdAt,
      });
    } else if (next && !isActiveTurn(turn)) {
      entries.push({ kind: 'unanswered', id: turn.id, turn });
    }
  });
  return entries;
}

/** The newest turn when it failed or was cancelled: Retry applies to it. */
export function discussionFailed(plan: PlanDetail): PlanTurnView | null {
  const last = plan.turns.at(-1);
  return last && ended(last) ? last : null;
}

/** The person's messages and the planner's replies so far. */
export function messageCount(plan: PlanDetail): number {
  return discussionEntries(plan).filter((e) => e.kind !== 'unanswered').length;
}

/** Every card the replies proposed. */
export function proposalCount(plan: PlanDetail): number {
  return plan.turns.reduce((n, t) => n + (t.reply?.proposals.length ?? 0), 0);
}

/**
 * What **Make a card** prefills as What to do: the proposal's title, then
 * its brief — the intake reads both.
 */
export const proposalBrief = (proposal: DiscussProposal): string =>
  `${proposal.title}\n\n${proposal.brief}`;

/**
 * A discussion on the Drafts strip: "Thinking…", "Failed — retry", or "6
 * messages · 2 cards proposed · 12 min ago". Null while the detail loads.
 */
export function discussStateText(
  plan: PlanDetail | undefined,
  now: number = Date.now(),
): string | null {
  if (!plan) return null;
  if (activeTurn(plan)) return 'Thinking…';
  if (discussionFailed(plan)) return 'Failed — retry';
  const proposed = proposalCount(plan);
  return [
    pluralize(messageCount(plan), 'message'),
    proposed > 0 ? `${pluralize(proposed, 'card')} proposed` : null,
    formatRelative(plan.updatedAt, now),
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

/** A draft that is a discussion. */
export const isDiscussion = (plan: Pick<PlanSummary, 'mode'>): boolean =>
  plan.mode === 'discuss';

/** The skills a discussion applies; none for any other plan. */
export const discussionSkills = (plan: PlanDetail | undefined): string[] =>
  plan?.discussion?.skills ?? [];
