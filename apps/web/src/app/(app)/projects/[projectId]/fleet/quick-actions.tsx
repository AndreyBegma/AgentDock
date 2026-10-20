'use client';

import type { OrchestratorStatus } from '@agentdock/shared';
import {
  ActionList,
  type ActionListItem,
} from '@andrewbehma/glass-ui/action-list';
import { ConfirmDialog } from '@andrewbehma/glass-ui/confirm-dialog';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import {
  FilePlus2,
  ListCollapse,
  MessageSquare,
  OctagonX,
  Pause,
  TerminalSquare,
  Waypoints,
} from 'lucide-react';
import { useState } from 'react';
import type { useControl } from '../../../../../lib/control/use-control';
import { showStopControl } from '../../../../../lib/fleet/format';
import { MessagePrompt } from './agent-node';
import type { ControlReasons } from './use-control-reasons';

type Confirm = 'pause' | 'stop-all' | 'message';

/**
 * Quick actions (#160). Nautelle does not create agents (ADR-0005): "New
 * issue" queues work for the orchestrator to dispatch. Pause all and Stop all
 * are the existing stop commands, each behind a confirmation.
 */
export function QuickActions({
  control,
  canOperate,
  orchestrator,
  reasons,
  orchestratorMessageReason,
  liveSlots,
  focusedSlot,
  hasOpen,
  onNewIssue,
  onAttach,
  onViewDependencies,
  onCollapseAll,
}: {
  control: ReturnType<typeof useControl>;
  canOperate: boolean;
  orchestrator: OrchestratorStatus;
  reasons: ControlReasons;
  /** Why the orchestrator cannot be messaged now; null when it can (#189). */
  orchestratorMessageReason: string | null;
  /** The slots Stop all would stop. */
  liveSlots: readonly string[];
  /** The slot in front, the one "Open worktree in terminal" attaches to. */
  focusedSlot: string | null;
  hasOpen: boolean;
  onNewIssue: () => void;
  /** Admins on a runner that can attach; absent leaves the rows disabled. */
  onAttach?: (key: string) => void;
  onViewDependencies: () => void;
  onCollapseAll: () => void;
}) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const stopBusy = control.busy('orchestrator.stop');
  const canStopOrchestrator =
    showStopControl(orchestrator) && reasons.stop === null;

  /** A confirmed stop is in flight; the dialog stays open until it returns. */
  const [working, setWorking] = useState(false);

  const pause = async () => {
    setWorking(true);
    try {
      await control.stop();
    } finally {
      setWorking(false);
      setConfirm(null);
    }
  };

  const stopAll = async () => {
    setWorking(true);
    try {
      // The orchestrator first, so it does not dispatch into the slots stopping.
      if (canStopOrchestrator) await control.stop();
      await Promise.all(liveSlots.map((slot) => control.stopSlot(slot)));
    } finally {
      setWorking(false);
      setConfirm(null);
    }
  };

  const items: ActionListItem[] = [];
  if (canOperate) {
    items.push({
      id: 'new-issue',
      label: 'New issue',
      description: 'Queue work; the orchestrator dispatches it.',
      icon: FilePlus2,
      onSelect: onNewIssue,
    });
  }
  items.push({
    id: 'message-orchestrator',
    label: 'Message orchestrator',
    description:
      orchestratorMessageReason ??
      'Writes into the orchestrator’s session, as if typed at its prompt.',
    icon: MessageSquare,
    disabled: orchestratorMessageReason !== null,
    onSelect: () => setConfirm('message'),
  });
  items.push({
    id: 'attach',
    label: 'Open worktree in terminal',
    description: !onAttach
      ? 'Admins on a runner that supports attach.'
      : focusedSlot
        ? `Attach to ${focusedSlot}.`
        : 'Open an agent first.',
    icon: TerminalSquare,
    disabled: !onAttach || focusedSlot === null,
    ...(onAttach && focusedSlot
      ? { onSelect: () => onAttach(focusedSlot) }
      : {}),
  });
  items.push({
    id: 'dependencies',
    label: 'View dependencies',
    icon: Waypoints,
    onSelect: onViewDependencies,
  });
  if (canOperate) {
    items.push({
      id: 'pause',
      label: 'Pause all',
      description:
        reasons.stop?.text ??
        'Stops the orchestrator; workers finish what they hold.',
      icon: Pause,
      disabled: !canStopOrchestrator || stopBusy,
      onSelect: () => setConfirm('pause'),
    });
    items.push({
      id: 'stop-all',
      label: 'Stop all',
      description:
        liveSlots.length > 0 || canStopOrchestrator
          ? 'The orchestrator and every running slot.'
          : 'Nothing is running.',
      icon: OctagonX,
      tone: 'danger',
      disabled: (liveSlots.length === 0 && !canStopOrchestrator) || stopBusy,
      onSelect: () => setConfirm('stop-all'),
    });
  }
  items.push({
    id: 'collapse',
    label: 'Collapse all',
    description: 'Close every open agent.',
    icon: ListCollapse,
    disabled: !hasOpen,
    onSelect: onCollapseAll,
  });

  return (
    <>
      <ActionList heading="Quick actions" surface="content" items={items} />

      <DialogRoot
        open={confirm === 'message'}
        onOpenChange={(open) => setConfirm(open ? 'message' : null)}
      >
        <DialogContent
          title="Message the orchestrator"
          description="It reads your message in its own session and answers there. Workers are messaged from their cards."
        >
          <MessagePrompt
            target={{ kind: 'orchestrator' }}
            control={control}
            disabledReason={orchestratorMessageReason}
            multiline
            autoFocus
            onSent={() => setConfirm(null)}
          />
        </DialogContent>
      </DialogRoot>

      <ConfirmDialog
        open={confirm === 'pause'}
        onOpenChange={(open) => setConfirm(open ? 'pause' : null)}
        title="Pause all?"
        consequence="Stops the orchestrator, so nothing new is dispatched, and any prompt it is in the middle of is lost. Workers keep running, and no worktree, branch or slot is touched. Start it again to resume."
        verb="Pause"
        busy={working}
        onConfirm={pause}
      />

      <ConfirmDialog
        open={confirm === 'stop-all'}
        onOpenChange={(open) => setConfirm(open ? 'stop-all' : null)}
        title="Stop everything?"
        consequence={
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-ink-2">
              Kills these sessions; unsaved work in each is lost. Worktrees and
              branches are kept, and commits are not lost.
            </p>
            <ul className="flex flex-col gap-1">
              {canStopOrchestrator ? <li>The orchestrator</li> : null}
              {liveSlots.map((slot) => (
                <li key={slot}>
                  Slot <span className="font-mono">{slot}</span>
                </li>
              ))}
            </ul>
          </div>
        }
        verb="Stop all"
        busy={working}
        onConfirm={stopAll}
      />
    </>
  );
}
