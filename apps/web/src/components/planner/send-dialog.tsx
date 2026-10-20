'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import type { PlanDetail, PlannerSpecOutput } from '@nautelle/shared';
import { pluralize } from '../../lib/format';
import {
  ISSUE_LABEL,
  KIND_HUE,
  KIND_LABEL,
  SPEC_OUTPUT_LABEL,
  tasksToSend,
} from '../../lib/planner/format';

/**
 * The confirmation before **Send to fleet** (D8, D10, D12): the issues it
 * will create, how specifications are published, and — for a private plan —
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
              <li
                key={t.key}
                className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
              >
                <Badge hue={KIND_HUE[t.kind]} label={KIND_LABEL[t.kind]} />
                <span className="min-w-0 flex-1 break-words text-ink">
                  <span className="text-ink-3">{t.key}</span> {t.title}
                </span>
                <span className="text-xs text-ink-3">
                  label {ISSUE_LABEL[t.kind]}
                  {t.dependsOn.length > 0
                    ? ` · after ${t.dependsOn.join(', ')}`
                    : ''}
                </span>
              </li>
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
