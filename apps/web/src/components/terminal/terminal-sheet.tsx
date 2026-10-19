'use client';

import type { PendingQuestion } from '@agentdock/shared';
import type { TerminalMode } from '@agentdock/shared/protocol';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Chip } from '@andrewbehma/glass-ui/chip';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { type ReactNode, useEffect, useState } from 'react';
import type { SendSessionMessage } from '../../lib/session-message/actions';
import {
  TERMINAL_PHASE_LABEL,
  type TerminalPhase,
} from '../../lib/terminal/format';
import { SessionMessageLine } from '../session/session-message-line';
import { useNarrow } from '../shell/narrow';
import { PhoneBackBar } from '../shell/phone-back-bar';
import {
  type TerminalStatus,
  type TerminalTarget,
  TerminalView,
} from './terminal-view';

const PHASE_TONE = {
  requesting: 'neutral',
  connecting: 'warn',
  reconnecting: 'warn',
  failed: 'danger',
  attached: 'ok',
  ended: 'neutral',
  refused: 'danger',
} as const satisfies Record<
  TerminalPhase,
  'neutral' | 'warn' | 'ok' | 'danger'
>;

const TARGET_LABEL: Record<TerminalTarget['kind'], string> = {
  slot: 'Slot terminal',
  orchestrator: 'Orchestrator terminal',
  skill_run: 'Skill run terminal',
  manual: 'Session terminal',
  card: 'Card terminal',
};

/** How to message the session from the read-only view (#489). */
type TerminalMessage = {
  send: SendSessionMessage;
  question?: PendingQuestion | null;
};

/**
 * The sheet's footer: the message line in read-only mode and, on a phone
 * (#679), the shared back bar under it. The bar sits in the footer, in flow,
 * so it never covers the terminal or the message line; from `lg` up it is not
 * rendered and the footer is what it was. A plain function rather than a
 * component: the sheet draws its bordered footer for any truthy node, so it
 * must see `undefined` when there is nothing to show.
 */
export function terminalSheetFooter({
  narrow,
  mode,
  title,
  message,
  backTo,
  onClose,
}: {
  narrow: boolean;
  mode: TerminalMode;
  title: string;
  message?: TerminalMessage;
  backTo?: string;
  onClose: () => void;
}): ReactNode | undefined {
  const line =
    message && mode === 'read' ? (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-ink-3">
          Message to the session, not typed into the terminal
        </p>
        <SessionMessageLine
          send={message.send}
          question={message.question}
          label={`Message ${title}`}
          tone="on-glass"
        />
      </div>
    ) : null;
  if (!narrow) return line ?? undefined;
  return (
    <div className="flex flex-col gap-2">
      {line}
      <PhoneBackBar
        kind={backTo ? 'back' : 'close'}
        label={backTo}
        title={title}
        placement="inline"
        onExit={onClose}
      />
    </div>
  );
}

/**
 * The full-screen terminal of spec 29 UI. It opens read-only; **Take control**
 * is a separate, explicit second attach. Closing the sheet detaches and the
 * session keeps running. With `message` (#489 M2), the read-only view has a
 * line under it to write to the session without taking control. On a phone
 * (#679) the sheet is left through the shared back bar at its foot, which
 * rides on the soft keyboard.
 */
export function TerminalSheet({
  projectId,
  target,
  title,
  onClose,
  message,
  backTo,
}: {
  projectId: string;
  /** `undefined` keeps the sheet closed. */
  target: TerminalTarget | undefined;
  title: string;
  onClose: () => void;
  /** #489: how to message this session; absent where the person cannot. */
  message?: TerminalMessage;
  /** #679: the page the phone back bar returns to ("Fleet"); Close without it. */
  backTo?: string;
}) {
  const narrow = useNarrow();
  const [mode, setMode] = useState<TerminalMode>('read');
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>({
    phase: 'requesting',
  });

  const targetKey = target
    ? `${target.kind}:${
        'slot' in target
          ? target.slot
          : 'runId' in target
            ? target.runId
            : 'sessionId' in target
              ? target.sessionId
              : 'cardId' in target
                ? target.cardId
                : ''
      }`
    : '';
  // Every target opens read-only, never in the previous target's mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: targetKey is the reset trigger
  useEffect(() => {
    setMode('read');
    setStatus({ phase: 'requesting' });
  }, [targetKey]);

  const live =
    status.phase === 'requesting' ||
    status.phase === 'connecting' ||
    status.phase === 'reconnecting' ||
    status.phase === 'attached';
  const switchMode = (next: TerminalMode) => {
    setMode(next);
    setStatus({ phase: 'requesting' });
    setAttempt((n) => n + 1);
  };
  const reconnect = () => {
    setStatus({ phase: 'requesting' });
    setAttempt((n) => n + 1);
  };

  return (
    <SheetRoot
      open={target !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target ? (
        <SheetContent
          side="right"
          title={title}
          description={TARGET_LABEL[target.kind]}
          className="w-full max-w-none max-lg:pb-(--keyboard-inset) sm:w-[min(100vw,72rem)]"
          footer={terminalSheetFooter({
            narrow,
            mode,
            title,
            message,
            backTo,
            onClose,
          })}
        >
          <div className="flex h-full flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex items-center gap-2">
                <Badge dot tone={PHASE_TONE[status.phase]} aria-hidden />
                <span className="text-sm" role="status">
                  {TERMINAL_PHASE_LABEL[status.phase]}
                </span>
                <Chip size="sm">
                  {mode === 'write' ? 'in control' : 'read-only'}
                </Chip>
              </div>
              <div className="flex items-center gap-2">
                {mode === 'read' ? (
                  <Button
                    variant="solid"
                    size="sm"
                    onClick={() => switchMode('write')}
                  >
                    Take control
                  </Button>
                ) : (
                  <Button
                    variant="solid"
                    size="sm"
                    onClick={() => switchMode('read')}
                  >
                    Release
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onClose}>
                  Detach
                </Button>
              </div>
            </div>
            {mode === 'write' ? (
              <Banner tone="danger">
                Your keystrokes go to a live agent session.
              </Banner>
            ) : null}
            {status.message ? (
              <Banner
                tone={
                  status.phase === 'refused' || status.phase === 'failed'
                    ? 'danger'
                    : 'info'
                }
              >
                <span className="flex flex-wrap items-center gap-3">
                  {status.message}
                  {!live ? (
                    <Button variant="glass" size="sm" onClick={reconnect}>
                      {status.phase === 'failed' ? 'Retry' : 'Attach again'}
                    </Button>
                  ) : null}
                </span>
              </Banner>
            ) : null}
            <div className="min-h-0 flex-1">
              <TerminalView
                key={`${attempt}:${mode}`}
                projectId={projectId}
                target={target}
                mode={mode}
                onStatus={setStatus}
              />
            </div>
          </div>
        </SheetContent>
      ) : null}
    </SheetRoot>
  );
}
