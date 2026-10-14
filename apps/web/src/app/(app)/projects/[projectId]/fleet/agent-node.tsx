'use client';

import type { FleetGraphNode } from '@agentdock/shared';
import type { ContextMenuAction } from '@andrewbehma/glass-ui/context-menu';
import { NodeCard } from '@andrewbehma/glass-ui/node-card';
import { PromptInput } from '@andrewbehma/glass-ui/prompt-input';
import {
  Bot,
  GitBranch,
  PanelRight,
  TerminalSquare,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import {
  MESSAGE_MAX_BYTES,
  messageProblem,
} from '../../../../../lib/control/format';
import type { useControl } from '../../../../../lib/control/use-control';
import {
  issueLine,
  modelLine,
  nodeHue,
  nodeTitle,
  PILL_LABEL,
  PILL_STATUS,
  progressBar,
} from '../../../../../lib/fleet/graph';

/** Said in place of the orchestrator's prompt until #189 gives it a command. */
export const ORCHESTRATOR_MESSAGE_REASON =
  'Messaging the orchestrator needs a control command AgentDock does not have yet (#189).';

/**
 * The one-line "message worker" box in a card's footer. Controlled, so a send
 * that failed keeps its text; the `nodrag nopan nowheel` classes keep the
 * canvas from taking the clicks and keys typed into it.
 */
function WorkerPrompt({
  slot,
  control,
  disabledReason,
}: {
  slot: string;
  control: ReturnType<typeof useControl>;
  disabledReason: string | null;
}) {
  const [text, setText] = useState('');
  const sending = control.busy('slot.message', slot);
  const tooLong = messageProblem(text) === 'too_long';

  const send = async (value: string) => {
    if (messageProblem(value) !== null) return;
    const run = await control.message(slot, value);
    if (run) setText('');
  };

  const reason = disabledReason ?? (sending ? 'Sending…' : null);

  return (
    <div className="nodrag nopan nowheel flex flex-col gap-1">
      <PromptInput
        size="sm"
        multiline={false}
        value={text}
        onValueChange={setText}
        onSubmit={send}
        placeholder={`Message ${slot}…`}
        aria-label={`Message worker ${slot}`}
        sendLabel={`Send to ${slot}`}
        disabled={reason !== null}
        {...(reason !== null ? { disabledReason: reason } : {})}
      />
      {tooLong ? (
        <p className="text-xs text-danger" role="alert">
          Over the {MESSAGE_MAX_BYTES / 1024} KB limit.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One agent as a card: its identity hue, its pill, the issue, the model and
 * runtime, how far it got and its worktree, with a prompt underneath. The same
 * card is the canvas's node and the mobile list's row.
 */
export function AgentNode({
  node,
  selected,
  control,
  canOperate,
  onOpen,
  onAttach,
  size = 'compact',
}: {
  node: FleetGraphNode;
  selected: boolean;
  control: ReturnType<typeof useControl>;
  canOperate: boolean;
  onOpen: () => void;
  /** Admins on a runner that can attach; absent hides the action. */
  onAttach?: () => void;
  size?: 'compact' | 'regular';
}) {
  const progress = progressBar(node);
  const title = nodeTitle(node);
  const hue = nodeHue(node);
  const actions: ContextMenuAction[] = [
    { id: 'open', label: 'Open', icon: PanelRight, onSelect: onOpen },
  ];
  if (onAttach && node.kind !== 'planned') {
    actions.push({
      id: 'attach',
      label: 'Open in terminal',
      icon: TerminalSquare,
      onSelect: onAttach,
    });
  }

  let footer = null;
  if (node.kind === 'orchestrator') {
    footer = (
      <PromptInput
        className="nodrag nopan nowheel"
        size="sm"
        multiline={false}
        onSubmit={() => {}}
        aria-label="Message the orchestrator"
        disabled
        disabledReason={ORCHESTRATOR_MESSAGE_REASON}
      />
    );
  } else if (node.kind === 'slot') {
    footer = (
      <WorkerPrompt
        slot={node.slot}
        control={control}
        disabledReason={
          !canOperate
            ? 'Operators and admins can message a worker.'
            : node.status === 'ended'
              ? 'This run has ended.'
              : null
        }
      />
    );
  }

  return (
    <NodeCard
      size={size}
      title={title}
      icon={node.kind === 'orchestrator' ? Workflow : Bot}
      {...(hue ? { hue } : {})}
      status={PILL_STATUS[node.pill]}
      statusLabel={node.kind === 'planned' ? 'Planned' : PILL_LABEL[node.pill]}
      description={
        <span className="flex flex-col gap-0.5">
          {issueLine(node) ? (
            <span className="line-clamp-2 text-ink">{issueLine(node)}</span>
          ) : null}
          <span className="text-ink-3">{modelLine(node)}</span>
        </span>
      }
      {...(progress
        ? {
            progress: {
              value: progress.value,
              max: 100,
              label: progress.label,
            },
          }
        : {})}
      {...(node.kind === 'slot' && node.branch
        ? { tag: { label: 'worktree', value: node.branch, icon: GitBranch } }
        : {})}
      footer={footer}
      actions={actions}
      selected={selected}
      onSelect={onOpen}
    />
  );
}
