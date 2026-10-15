import { type BoardPlanTaskView, planTaskBoardLabel } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { planTaskDesignChip, planTaskPill } from '../../lib/board/plan-tasks';
import { safeHttpsUrl } from '../../lib/queue/format';
import { TASK_KIND_LABEL } from '../../lib/tasks/format';

/**
 * What a plan task shows on the board (#270 D6): the Plan badge, `key · plan
 * title`, the kind, the title (it opens the sheet), the status pill, the
 * design chip and the issue and pull request links. Read-only: nothing on it
 * changes the task.
 */
export function PlanTaskFace({
  task,
  onOpen,
}: {
  task: BoardPlanTaskView;
  onOpen: (task: BoardPlanTaskView) => void;
}) {
  const pill = planTaskPill(task);
  const design = planTaskDesignChip(task);
  const issueHref = task.issue ? safeHttpsUrl(task.issue.url) : null;
  const prHref = task.issue?.prUrl ? safeHttpsUrl(task.issue.prUrl) : null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
        <Badge size="sm" label="Plan" />
        <span className="min-w-0 break-words font-mono">
          {planTaskBoardLabel(task.key, task.planTitle)}
        </span>
        {task.kind === 'bug' ? (
          <Chip size="sm" tone="danger">
            {TASK_KIND_LABEL.bug}
          </Chip>
        ) : null}
      </div>
      <button
        type="button"
        className="break-words text-left font-medium underline-offset-2 hover:underline"
        onClick={() => onOpen(task)}
      >
        {task.title}
      </button>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill size="sm" status={pill.status} label={pill.label} />
        {design ? (
          <Badge
            size="md"
            tone={design.approved ? 'ok' : 'neutral'}
            label={design.label}
          />
        ) : null}
      </div>
      {task.issue ? (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {task.issue.prNumber !== null ? (
            <ExternalLink href={prHref}>PR #{task.issue.prNumber}</ExternalLink>
          ) : null}
          <ExternalLink href={issueHref}>
            Issue #{task.issue.number}
          </ExternalLink>
        </div>
      ) : null}
    </div>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string | null;
  children: React.ReactNode;
}) {
  if (!href) return <Chip size="sm">{children}</Chip>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-full bg-hover px-2 py-0.5 text-ink-2 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}
