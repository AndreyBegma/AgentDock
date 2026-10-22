'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import type {
  PlanDetail,
  PlannerSpecOutput,
  PlanTaskView,
} from '@nautelle/shared';
import { useState } from 'react';
import { pluralize } from '../../lib/format';
import {
  ISSUE_LABEL,
  KIND_HUE,
  KIND_LABEL,
  SPEC_OUTPUT_LABEL,
  sendBodyOf,
  tasksToSend,
} from '../../lib/planner/format';

/**
 * One issue Send will create (C-177): its title row, and its body collapsed
 * underneath, so the person can read exactly what goes to GitHub.
 */
export function SendTaskItem({
  task,
  open,
  onOpenChange,
}: {
  task: PlanTaskView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <li>
      <Disclosure
        open={open}
        onOpenChange={onOpenChange}
        triggerClassName="px-3 py-2 font-normal"
        trigger={
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
            <Badge hue={KIND_HUE[task.kind]} label={KIND_LABEL[task.kind]} />
            <span className="min-w-0 flex-1 break-words text-ink">
              <span className="text-ink-3">{task.key}</span> {task.title}
            </span>
            <span className="text-xs text-ink-3">
              label {ISSUE_LABEL[task.kind]}
              {task.dependsOn.length > 0
                ? ` · after ${task.dependsOn.join(', ')}`
                : ''}
              {open ? ' · hide body' : ' · show body'}
            </span>
          </span>
        }
      >
        <CodeBlock
          language="markdown"
          code={sendBodyOf(task)}
          wrap
          maxHeight={240}
          copy={false}
        />
      </Disclosure>
    </li>
  );
}

/**
 * The confirmation before **Send to fleet** (D8, D10, D12): the issues it
 * will create, each body one click away (C-177), how specifications are published, and — for a private plan —
 * that sending shares it with the project first, and why.
 */
export function SendDialog({
  plan,
  open,
  specOutput,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  plan: PlanDetail;
  open: boolean;
  /** The project's setting; undefined when it could not be read. */
  specOutput: PlannerSpecOutput | undefined;
  busy: boolean;
  error: string | undefined;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const tasks = tasksToSend(plan);
  const rejected = plan.tasks.filter((t) => t.status === 'rejected').length;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string, open: boolean) =>
    setExpanded((now) => {
      const next = new Set(now);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <DialogRoot open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title="Send to fleet"
        description={`Creates ${pluralize(tasks.length, 'issue')} on GitHub and queues them for the orchestrator.`}
        footer={
          <>
            <Button
              variant="glass"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={busy || tasks.length === 0} onClick={onConfirm}>
              {busy ? 'Sending…' : `Create ${pluralize(tasks.length, 'issue')}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {plan.visibility === 'private' ? (
            <Banner
              tone="warn"
              title="This plan becomes visible to the project"
            >
              The issues are visible to everyone with access to the repository,
              so the plan is shared with the project before they are created.
            </Banner>
          ) : null}
          <ul className="flex flex-col gap-2" aria-label="Issues to create">
            {tasks.map((t) => (
              <SendTaskItem
                key={t.key}
                task={t}
                open={expanded.has(t.key)}
                onOpenChange={(next) => toggle(t.key, next)}
              />
            ))}
          </ul>
          {rejected > 0 ? (
            <p className="text-sm text-ink-3">
              {pluralize(rejected, 'rejected task')} will not become{' '}
              {rejected === 1 ? 'an issue' : 'issues'}.
            </p>
          ) : null}
          <p className="text-sm text-ink-2">
            {specOutput
              ? SPEC_OUTPUT_LABEL[specOutput]
              : 'Specifications are published as the project’s Planner settings say.'}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
