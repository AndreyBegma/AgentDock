'use client';

import type { PairingCodeResponse } from '@agentdock/shared';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { toast } from 'glass-ui/toast';
import { useEffect, useState } from 'react';
import { formatCountdown } from '../../../lib/runners/format';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Could not copy — select the text and copy it by hand.');
  }
}

/**
 * Shows a pairing code once. The code lives only in this component's props:
 * closing the dialog drops it, and the server never returns it again.
 */
export function PairingDialog({
  result,
  onClose,
  onNewCode,
}: {
  result: PairingCodeResponse | null;
  onClose: () => void;
  onNewCode: (runnerId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!result) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [result]);

  const left = result ? formatCountdown(result.expiresAt, now) : null;

  return (
    <DialogRoot
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {result ? (
        <DialogContent
          title={`Pair ${result.runner.name}`}
          description="Run this on the machine. The code is shown once, works once and expires; it cannot be shown again."
          footer={
            <>
              {left === null ? (
                <Button
                  variant="glass"
                  onClick={() => onNewCode(result.runner.id)}
                >
                  New pairing code
                </Button>
              ) : null}
              <Button variant="solid" onClick={onClose}>
                Done
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <span
                data-testid="pairing-code"
                className="font-mono text-2xl font-semibold tracking-widest"
              >
                {result.pairingCode}
              </span>
              <span
                className={left === null ? 'text-danger' : 'text-ink-2'}
                aria-live="polite"
              >
                {left === null ? 'Expired' : `Expires in ${left}`}
              </span>
            </div>
            <pre
              data-testid="pairing-command"
              className="overflow-x-auto rounded-surface bg-hover p-3 font-mono text-xs"
            >
              {result.command}
            </pre>
            <div className="flex gap-2">
              <Button
                variant="glass"
                size="sm"
                onClick={() => copy(result.pairingCode, 'Code')}
              >
                Copy code
              </Button>
              <Button
                variant="glass"
                size="sm"
                onClick={() => copy(result.command, 'Command')}
              >
                Copy command
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
