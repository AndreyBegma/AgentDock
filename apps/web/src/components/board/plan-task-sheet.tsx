'use client';

import type { BoardPlanTaskView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import Link from 'next/link';
import { COLUMN_TITLE } from '../../lib/board/format';
import { planTaskDesignChip, planTaskPill } from '../../lib/board/plan-tasks';
import { designHref } from '../../lib/design/href';
import { Time } from '../../lib/format/time';
import { planHref } from '../../lib/planner/href';
import { safeHttpsUrl } from '../../lib/queue/format';
import { TASK_KIND_LABEL } from '../../lib/tasks/format';
import { Markdown } from '../markdown/markdown';

/**
 * The plan-task sheet (#270 D7): read-only. Every change to a plan task stays
 * in the Planner, so the one solid action is **Open in Planner**.
 * `task` is `undefined` while the board loads or when the task is not (or no
 * longer) on it.
 */
export function PlanTaskSheet({
  projectId,
  open,
  task,
  loading,
  onClose,
}: {
  projectId: string;
  open: boolean;
  task: BoardPlanTaskView | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <SheetRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? (
        <SheetContent
          side="right"
          title={task ? `${task.key} ${task.title}` : 'Plan task'}
          description="Plan task"
          footer={
            task ? (
              <div className="flex items-center justify-end">
                <Link
                  href={planHref(projectId, task.planId, task.key)}
                  className={buttonClassName({ variant: 'solid' })}
                >
                  Open in Planner
                </Link>
              </div>
            ) : undefined
          }
        >
          {task ? (
            <PlanTaskBody projectId={projectId} task={task} />
          ) : loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <p className="text-sm text-ink-2">
              This plan task is not on the board any more — it was rejected, its
              plan was archived, or you cannot read the plan.
            </p>
          )}
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}

function PlanTaskBody({
  projectId,
  task,
}: {
  projectId: string;
  task: BoardPlanTaskView;
}) {
  const pill = planTaskPill(task);
  const design = planTaskDesignChip(task);
  const issueHref = task.issue ? safeHttpsUrl(task.issue.url) : null;
  const prHref = task.issue?.prUrl ? safeHttpsUrl(task.issue.prUrl) : null;
  const opensDesign =
    task.design !== null &&
    (task.design.needed || task.design.status === 'approved');
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Plan task" className="flex flex-col gap-4">
        <SectionHeader title="Plan task" headingLevel={3} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge size="sm" label="Plan" />
          <span className="font-medium">{COLUMN_TITLE[task.column]}</span>
          <StatusPill size="sm" status={pill.status} label={pill.label} />
          <Chip size="sm" tone={task.kind === 'bug' ? 'danger' : undefined}>
            {TASK_KIND_LABEL[task.kind]}
          </Chip>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-2">Plan</dt>
          <dd className="min-w-0 break-words">{task.planTitle}</dd>
          <dt className="text-ink-2">Key</dt>
          <dd className="font-mono">{task.key}</dd>
          <dt className="text-ink-2">Updated</dt>
          <dd>
            <Time value={task.updatedAt} />
          </dd>
        </dl>
        {task.issue ? (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {task.issue.prNumber !== null ? (
              <ExternalLink href={prHref}>
                PR #{task.issue.prNumber}
              </ExternalLink>
            ) : null}
            <ExternalLink href={issueHref}>
              Issue #{task.issue.number}
            </ExternalLink>
          </div>
        ) : null}
      </section>

      {design ? (
        <section aria-label="Design" className="flex flex-col gap-3">
          <SectionHeader title="Design" headingLevel={3} />
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              size="md"
              tone={design.approved ? 'ok' : 'neutral'}
              label={design.label}
            />
            {opensDesign ? (
              <Link
                href={designHref(projectId, task.planId, task.key)}
                className={buttonClassName({ variant: 'glass', size: 'sm' })}
              >
                Open design
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-label="Summary" className="flex flex-col gap-3">
        <SectionHeader title="Summary" headingLevel={3} />
        {task.summary.trim() ? (
          <Markdown>{task.summary}</Markdown>
        ) : (
          <p className="text-sm text-ink-3">No summary.</p>
        )}
      </section>
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
