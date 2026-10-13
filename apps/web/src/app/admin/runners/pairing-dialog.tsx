'use client';

import {
  type AdminRunner,
  type PairingCodeResponse,
  pairCommand,
} from '@agentdock/shared';
import { Banner } from 'glass-ui/banner';
import { Button, buttonClassName } from 'glass-ui/button';
import { CodeBlock } from 'glass-ui/code-block';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { toast } from 'glass-ui/toast';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import {
  InstallCommands,
  KeepOnlineCommands,
} from '../../../components/onboarding/runner-commands';
import { isRunnerOnline } from '../../../lib/prerequisites/facts';
import { formatCountdown } from '../../../lib/runners/format';
import { pairingServers } from '../../../lib/runners/install';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Could not copy — select the text and copy it by hand.');
  }
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        {number}. {title}
      </h3>
      <div className="flex flex-col gap-2 text-sm text-ink-2">{children}</div>
    </li>
  );
}

/** The page's origin, read after mount so the server render matches. */
function useOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

/**
 * Shows a pairing code once. The code lives only in this component's props:
 * closing the dialog drops it, and the server never returns it again.
 * `runner` is the same runner as the page's poll sees it, so the dialog can
 * say when it came online.
 */
export function PairingDialog({
  result,
  runner,
  onClose,
  onNewCode,
}: {
  result: PairingCodeResponse | null;
  runner: AdminRunner | undefined;
  onClose: () => void;
  onNewCode: (runnerId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const origin = useOrigin();

  useEffect(() => {
    if (!result) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [result]);

  const left = result ? formatCountdown(result.expiresAt, now) : null;
  // `result.runner` is the row as the code was issued: a runner that was
  // already online then (a re-pair) has not just come online.
  const online =
    result !== null &&
    !isRunnerOnline(result.runner.status) &&
    runner !== undefined &&
    isRunnerOnline(runner.status);
  const servers =
    result && origin ? pairingServers(origin, result.command) : null;
  const command =
    result && servers
      ? pairCommand(servers.primary, result.pairingCode)
      : (result?.command ?? '');
  const alternative =
    result && servers?.alternative
      ? pairCommand(servers.alternative, result.pairingCode)
      : null;

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
          description="Run these on the machine that holds your repositories. The code is shown once, works once and expires."
          footer={
            <>
              {left === null && !online ? (
                <Button
                  variant="glass"
                  onClick={() => onNewCode(result.runner.id)}
                >
                  New pairing code
                </Button>
              ) : null}
              <Button variant={online ? 'glass' : 'solid'} onClick={onClose}>
                Done
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {online && runner ? (
              <Banner
                tone="ok"
                title={`Paired: ${runner.name} is online.`}
                action={
                  <Link
                    href="/projects?connect=1"
                    className={buttonClassName({
                      variant: 'solid',
                      size: 'sm',
                    })}
                  >
                    Connect a project →
                  </Link>
                }
              >
                Next: connect a project that lives on it.
              </Banner>
            ) : null}

            <ol className="flex flex-col gap-4">
              <Step number={1} title="Install the runner">
                <p>Skip this if it is already installed.</p>
                <InstallCommands />
              </Step>

              <Step number={2} title="Pair it">
                <div className="flex items-center justify-between gap-3">
                  <span
                    data-testid="pairing-code"
                    className="font-mono text-2xl font-semibold tracking-widest text-ink"
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
                  className="overflow-x-auto rounded-surface bg-hover p-3 font-mono text-xs text-ink"
                >
                  {command}
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
                    onClick={() => copy(command, 'Command')}
                  >
                    Copy command
                  </Button>
                </div>
                {servers ? (
                  <p>
                    Run it on the runner&apos;s machine. It must reach{' '}
                    <span className="font-mono text-ink">
                      {servers.primary}
                    </span>
                    .
                  </p>
                ) : null}
                {alternative ? (
                  <>
                    <p>If that address is not reachable from there, use:</p>
                    <CodeBlock code={alternative} />
                  </>
                ) : null}
              </Step>

              <Step number={3} title="Keep it online">
                <p>Start it, and leave it running:</p>
                <KeepOnlineCommands />
                {!online ? (
                  <p aria-live="polite">
                    This dialog says so when the runner comes online.
                  </p>
                ) : null}
              </Step>
            </ol>
          </div>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
