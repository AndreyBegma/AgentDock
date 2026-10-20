'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { NodeCard, type NodeCardMeta } from '@andrewbehma/glass-ui/node-card';
import type { PlanTaskKind, PlanTaskView } from '@nautelle/shared';
import {
  Bug,
  CircleAlert,
  GitBranch,
  Lightbulb,
  type LucideIcon,
  MessageSquareText,
} from 'lucide-react';
import {
  approveHint,
  blockingText,
  canApprove,
  KIND_HUE,
  KIND_LABEL,
  taskStatusView,
} from '../../lib/planner/format';
import { DesignChip } from '../design/design-chip';
import { IssueLinks } from './issue-links';

export const KIND_ICON: Record<PlanTaskKind, LucideIcon> = {
  bug: Bug,
  feature: Lightbulb,
};

export type ReviewDecision = 'approve' | 'reject' | 'rewrite';

/**
 * A task of the plan (spec 172 UI, left column): kind as icon and hue, title,
 * summary, status, open blocking questions, the Design chip (spec 223), and
 * the review actions. The card
 * is pressable — it opens the task's panel; the actions sit above that layer.
 */
export function TaskCard({
  projectId,
  planId,
  task,
  selected,
  canReview,
  canDesign,
  hasUi,
  busy,
  onSelect,
  onReview,
  onDesignChanged,
}: {
  projectId: string;
  planId: string;
  task: PlanTaskView;
  selected: boolean;
  /** Operator on an open plan with no turn running. */
  canReview: boolean;
  /** Operator on an open plan: may switch the design (spec 223 D2). */
  canDesign: boolean;
  /** The UI profile's `hasUi`; null with no profile (spec 223 D3). */
  hasUi: boolean | null;
  busy: boolean;
  onSelect: () => void;
  onReview: (decision: ReviewDecision) => void;
  onDesignChanged: () => void;
}) {
  const view = taskStatusView(task);
  const blocking = blockingText(task.blockingOpen);
  const meta: NodeCardMeta[] = [
    ...(blocking
      ? [
          {
            id: 'blocking',
            icon: CircleAlert,
            value: blocking,
            label: 'open blocking questions',
          },
        ]
      : []),
    ...(task.dependsOn.length > 0
      ? [
          {
            id: 'deps',
            icon: GitBranch,
            value: `after ${task.dependsOn.join(', ')}`,
            label: 'depends on',
          },
        ]
      : []),
    ...(task.rewriteComment && task.status === 'rewrite_requested'
      ? [
          {
            id: 'rewrite',
            icon: MessageSquareText,
            value: 'rewrite asked',
            label: task.rewriteComment,
          },
        ]
      : []),
  ];
  const reviewable = canReview && task.status !== 'issued';

  return (
    <NodeCard
      size="compact"
      title={`${task.key} · ${task.title}`}
      icon={KIND_ICON[task.kind]}
      hue={KIND_HUE[task.kind]}
      status={view.status}
      statusLabel={view.label}
      glow={false}
      description={
        <span className="line-clamp-3">
          <span className="sr-only">{KIND_LABEL[task.kind]}. </span>
          {task.summary}
        </span>
      }
      meta={meta}
      selected={selected}
      onSelect={onSelect}
      headingLevel={3}
      footer={
        <div className="flex flex-col gap-2">
          <DesignChip
            projectId={projectId}
            planId={planId}
            task={task}
            hasUi={hasUi}
            canOperate={canDesign}
            onChanged={onDesignChanged}
          />
          {task.issue ? (
            <IssueLinks issue={task.issue} />
          ) : reviewable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="glass"
                disabled={busy || !canApprove(task)}
                title={approveHint(task)}
                onClick={() => onReview('approve')}
              >
                {task.status === 'approved' ? 'Approved' : 'Approve'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || task.status === 'rejected'}
                onClick={() => onReview('reject')}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onReview('rewrite')}
              >
                Rewrite…
              </Button>
            </div>
          ) : null}
        </div>
      }
    />
  );
}
