'use client';

import type { TerminalMode } from '@agentdock/shared/protocol';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { Chip } from 'glass-ui/chip';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { useEffect, useState } from 'react';
import {
  TERMINAL_PHASE_LABEL,
  type TerminalPhase,
} from '../../lib/terminal/format';
import {
  type TerminalStatus,
  type TerminalTarget,
  TerminalView,
} from './terminal-view';

const PHASE_TONE = {
  requesting: 'neutral',
  connecting: 'warn',
  attached: 'ok',
  ended: 'neutral',
  refused: 'danger',
} as const satisfies Record<
  TerminalPhase,
  'neutral' | 'warn' | 'ok' | 'danger'
>;

/**
 * The full-screen terminal of spec 29 UI. It opens read-only; **Take control**
 * is a separate, explicit second attach. Closing the sheet detaches and the
 * session keeps running.
 */
export function TerminalSheet({
  projectId,
  target,
  title,
  onClose,
}: {
  projectId: string;
  /** `undefined` keeps the sheet closed. */
  target: TerminalTarget | undefined;
  title: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<TerminalMode>('read');
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>({
    phase: 'requesting',
  });

  const targetKey = target
    ? `${target.kind}:${'slot' in target ? target.slot : ''}`
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
          description="Terminal attach"
          className="w-full max-w-none sm:w-[min(100vw,60rem)]"
        >
          <div className="flex h-full flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge dot tone={PHASE_TONE[status.phase]} aria-hidden />
              <span className="text-sm" role="status">
                {TERMINAL_PHASE_LABEL[status.phase]}
              </span>
              <Chip size="sm">
                {mode === 'write' ? 'in control' : 'read-only'}
              </Chip>
              <div className="ml-auto flex flex-wrap gap-2">
                {mode === 'read' ? (
                  <Button
                    variant="glass"
                    size="sm"
                    onClick={() => switchMode('write')}
                  >
                    Take control
                  </Button>
                ) : (
                  <Button
                    variant="glass"
                    size="sm"
                    onClick={() => switchMode('read')}
                  >
                    Release
                  </Button>
                )}
                <Button variant="glass" size="sm" onClick={onClose}>
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
              <Banner tone={status.phase === 'refused' ? 'danger' : 'info'}>
                <span className="flex flex-wrap items-center gap-3">
                  {status.message}
                  {!live ? (
                    <Button variant="glass" size="sm" onClick={reconnect}>
                      Attach again
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
