'use client';

import type { PlanTaskView, PlanTurnView } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import { Tabs, TabsItem } from '@andrewbehma/glass-ui/tabs';
import { X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { KIND_LABEL, taskStatusView } from '../../lib/planner/format';
import { Markdown } from '../markdown/markdown';
import { IssueLinks } from './issue-links';
import { TaskHistory } from './task-history';

const TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'document', label: 'Document' },
  { id: 'history', label: 'History' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * The right panel (spec 172 UI): the selected task's conversation, its
 * document, and its history. The conversation is the caller's, since it
 * talks to the API; this draws the frame and the two read-only tabs, the
 * history loading the task's plan versions itself.
 */
export function TaskPanel({
  projectId,
  planId,
  task,
  turns,
  conversation,
  onClose,
}: {
  projectId: string;
  planId: string;
  task: PlanTaskView;
  /** The task's turns, oldest first. */
  turns: readonly PlanTurnView[];
  conversation: ReactNode;
  onClose: () => void;
}) {
  // A task with open questions opens on them; a written one on its document.
  const [tab, setTab] = useState<TabId>(
    task.questions.length === 0 && task.document ? 'document' : 'conversation',
  );
  const view = taskStatusView(task);

  return (
    <Card
      variant="content"
      pad="md"
      className="flex min-w-0 flex-col gap-4"
      role="region"
      aria-labelledby="task-panel-title"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-ink-3">
            {KIND_LABEL[task.kind]} · {task.key}
          </span>
          <h2
            id="task-panel-title"
            className="text-base font-semibold break-words text-ink"
          >
            {task.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill size="sm" status={view.status} label={view.label} />
            {task.issue ? <IssueLinks issue={task.issue} /> : null}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon
          aria-label="Close the task"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <Tabs aria-label="Task sections">
        {TABS.map(({ id, label }) => (
          <TabsItem key={id} current={tab === id} layoutId="planner-task-tab">
            <button
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className="relative flex w-full items-center justify-center px-3 py-2 text-sm font-medium"
            >
              {label}
            </button>
          </TabsItem>
        ))}
      </Tabs>

      {tab === 'conversation' ? (
        conversation
      ) : tab === 'document' ? (
        task.document ? (
          <Markdown>{task.document}</Markdown>
        ) : (
          <p className="text-sm text-ink-3">
            {task.blockingOpen > 0
              ? 'The planner writes the document once the blocking questions are answered.'
              : 'No document yet. The planner writes it when the conversation is done.'}
          </p>
        )
      ) : (
        <TaskHistory
          projectId={projectId}
          planId={planId}
          task={task}
          turns={turns}
        />
      )}
    </Card>
  );
}
