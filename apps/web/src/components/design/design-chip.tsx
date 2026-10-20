'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { Toggle } from '@andrewbehma/glass-ui/toggle';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type { PlanTaskView, TaskDesignPatchRequest } from '@nautelle/shared';
import { Ellipsis } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { api } from '../../lib/api';
import {
  canToggleDesign,
  DESIGN_CHIP_LABEL,
  describeDesignError,
  designChipState,
  opensDesign,
  toggleBehindMenu,
} from '../../lib/design/format';
import { designApi, designHref } from '../../lib/design/href';
import { useErrorToast } from '../../lib/section/use-error-toast';

/** A badge is a fact, not a status (style system): only approval is toned. */
const CHIP_TONE = {
  off: 'neutral',
  suggested: 'neutral',
  on: 'neutral',
  approved: 'ok',
} as const;

/**
 * The Design chip on a Planner task card (spec 223 "UI", D2, D3): off,
 * suggested with the planner's one-line why, on, approved — with the toggle
 * for an operator, and **Open design** once there is one to open. A project
 * whose profile says it has no UI keeps the toggle behind "Design anyway",
 * which warns first; otherwise toggling asks nothing.
 */
export function DesignChip({
  projectId,
  planId,
  task,
  hasUi,
  canOperate,
  onChanged,
}: {
  projectId: string;
  planId: string;
  task: PlanTaskView;
  /** The profile's `hasUi`; null while the project has no profile. */
  hasUi: boolean | null;
  /** Operator on an open plan. */
  canOperate: boolean;
  /** After a toggle went through; the plan's push also refreshes it. */
  onChanged?: () => void;
}) {
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const showError = useErrorToast();

  const state = designChipState(task);
  const needed = task.design?.needed === true;
  const why = task.design?.suggestionWhy ?? null;
  const editable = canOperate && canToggleDesign(task);
  const hidden = toggleBehindMenu(task, hasUi);

  const patch = async (body: TaskDesignPatchRequest) => {
    setBusy(true);
    try {
      await api(designApi(projectId, planId, task.key), {
        method: 'PATCH',
        body,
      });
      onChanged?.();
    } catch (error) {
      showError(describeDesignError(error, projectId));
    } finally {
      setBusy(false);
    }
  };

  const badge = (
    <Badge
      id={labelId}
      size="md"
      tone={CHIP_TONE[state]}
      label={DESIGN_CHIP_LABEL[state]}
    />
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {why && state !== 'approved' ? (
        <Tooltip content={why}>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip's trigger must be focusable to reach the planner's reason */}
          <span tabIndex={0} className="rounded-full">
            {badge}
          </span>
        </Tooltip>
      ) : (
        badge
      )}
      {why && state !== 'approved' ? (
        <span className="sr-only">Planner: {why}</span>
      ) : null}

      {editable && !hidden ? (
        <span className={busy ? 'pointer-events-none opacity-60' : undefined}>
          <Toggle
            checked={needed}
            labelledBy={labelId}
            onChange={(next) => void patch({ needed: next })}
          />
        </span>
      ) : null}

      {editable && hidden ? (
        <>
          <MenuRoot>
            <MenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                icon
                aria-label="Design options"
                disabled={busy}
              >
                <Ellipsis aria-hidden="true" className="size-4" />
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem onSelect={() => setWarnOpen(true)}>
                Design anyway…
              </MenuItem>
            </MenuContent>
          </MenuRoot>
          <ConfirmDialog
            open={warnOpen}
            onOpenChange={setWarnOpen}
            title="Design a task in a project without UI?"
            consequence="The project's UI profile says it has no user interface, so the planner suggested no design. A design costs a planner turn per variant and holds the task until you approve it."
            verb="Design anyway"
            tone="default"
            busy={busy}
            onConfirm={() => {
              setWarnOpen(false);
              void patch({ needed: true });
            }}
          />
        </>
      ) : null}

      {opensDesign(task) ? (
        <Link
          href={designHref(projectId, planId, task.key)}
          className={buttonClassName({ variant: 'glass', size: 'sm' })}
        >
          Open design
        </Link>
      ) : null}
    </div>
  );
}
