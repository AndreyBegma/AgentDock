import type { PlanDetail, PlanTaskView } from '@agentdock/shared';
import { canApprove, isClosed } from './format';

/**
 * The brief as the header's description, without what the title already
 * says (#213). A new plan's title is the brief's first line, cut (the API's
 * `titleOf`); then the description is the rest of the brief, or nothing. Once
 * decomposition renamed the plan, the whole brief is new information.
 */
export function briefBeyondTitle(
  plan: Pick<PlanDetail, 'title' | 'brief'>,
): string | null {
  const lines = plan.brief.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) return null;
  const head = lines[first].trim();
  const title = plan.title.endsWith('…') ? plan.title.slice(0, -1) : plan.title;
  if (!head.startsWith(title)) return plan.brief.trim();
  const rest = lines
    .slice(first + 1)
    .join('\n')
    .trim();
  return rest === '' ? null : rest;
}

/**
 * Why **Create cards** (#337 D7) cannot go yet, or null. The API decides —
 * once per plan, `409 cards_exist` after — this only keeps the button
 * honest: tasks to make, no turn running, none made yet, no blocking
 * question left.
 */
export function createCardsBlock(
  plan: Pick<PlanDetail, 'mode' | 'status' | 'activeTurnId' | 'tasks'>,
): string | null {
  if (plan.mode === 'card') return 'An intake makes its own card.';
  if (isClosed(plan)) return 'This plan was sent, archived or made its cards.';
  if (plan.tasks.some((t) => t.cardId !== null)) {
    return 'This plan already made its cards.';
  }
  if (plan.tasks.length === 0) return 'The planner has no tasks yet.';
  if (plan.activeTurnId) return 'Wait for the running turn to finish.';
  if (plan.tasks.some((t) => t.status === 'needs_talk')) {
    return 'A task still has a blocking question.';
  }
  return null;
}

/** **Approve all drafts**: the drafted tasks nothing stops approving (D6). */
export const approvableDrafts = (plan: Pick<PlanDetail, 'tasks'>) =>
  plan.tasks.filter(
    (t: PlanTaskView) =>
      (t.status === 'draft' || t.status === 'ready') && canApprove(t),
  );
