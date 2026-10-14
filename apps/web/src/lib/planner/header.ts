import type { PlanDetail, PlanTaskView } from '@agentdock/shared';
import { canApprove } from './format';

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

/** **Approve all drafts**: the drafted tasks nothing stops approving (D6). */
export const approvableDrafts = (plan: Pick<PlanDetail, 'tasks'>) =>
  plan.tasks.filter(
    (t: PlanTaskView) =>
      (t.status === 'draft' || t.status === 'ready') && canApprove(t),
  );
