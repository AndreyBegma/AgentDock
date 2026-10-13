'use client';

import type {
  AdminRunner,
  ConnectProjectRequest,
  InspectProjectRequest,
  ProjectDetail,
} from '@agentdock/shared';
import type { ProjectInspection } from '@agentdock/shared/protocol';
import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type FormEvent, useEffect, useState } from 'react';
import { InstallGuideLink } from '../../../components/onboarding/runner-commands';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { PrerequisiteBanner } from '../../../components/prerequisites/prerequisite-banner';
import { api } from '../../../lib/api';
import {
  isRunnerOnline,
  type RunnersFact,
  runnersFact,
} from '../../../lib/prerequisites/facts';
import {
  BASE_SOURCE_LABEL,
  connectBlocker,
  describeProjectError,
  noOnlineRunnerCopy,
  suggestedPathOf,
} from '../../../lib/projects/format';
import { DocsDetails } from './docs-details';

const yesNo = (value: boolean) => (value ? 'found' : 'not found');

/** While the dialog is open; the runner usually comes up in another window. */
const RUNNERS_POLL_MS = 10_000;

const REASON_ID = 'connect-project-reason';

/** Above the form: why the runner list is empty, and the fix. */
function NoOnlineRunner({ fleet }: { fleet: RunnersFact }) {
  const copy = noOnlineRunnerCopy(fleet);
  if (!copy) return null;
  const { command, body, ...banner } = copy;
  return (
    <PrerequisiteBanner
      {...banner}
      body={
        <>
          {body}
          {command ? (
            <code className="ml-1 font-mono text-ink">{command}</code>
          ) : null}
          <InstallGuideLink>
            How to install and start the runner
          </InstallGuideLink>
        </>
      }
    />
  );
}

function Preview({ inspection }: { inspection: ProjectInspection }) {
  const { remote, codeSentinelConfig } = inspection;
  return (
    <div className="flex flex-col gap-4" data-testid="inspection-preview">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-2">Repository</dt>
        <dd>{remote.repo ?? remote.url ?? 'no origin'}</dd>
        <dt className="text-ink-2">Checkout</dt>
        <dd className="font-mono break-all">{inspection.root}</dd>
        <dt className="text-ink-2">Base branch</dt>
        <dd>
          {inspection.baseBranch}
          <span className="text-ink-3">
            {' '}
            · {BASE_SOURCE_LABEL[inspection.baseSource]}
          </span>
        </dd>
        <dt className="text-ink-2">Code Sentinel config</dt>
        <dd>
          {codeSentinelConfig.error ? (
            `invalid: ${codeSentinelConfig.error}`
          ) : codeSentinelConfig.orchestrator ? (
            'found'
          ) : (
            <>
              not found
              <span className="block text-xs text-ink-3">
                You can still connect. The orchestrator (Fleet, Queue) stays off
                until the repository has a{' '}
                <code className="font-mono">.code-analyzer-config.json</code>{' '}
                with an <code className="font-mono">orchestrator</code> block.
              </span>
            </>
          )}
        </dd>
        <dt className="text-ink-2">CLAUDE.md</dt>
        <dd>{yesNo(inspection.hasClaudeMd)}</dd>
        <dt className="text-ink-2">AGENTS.md</dt>
        <dd>{yesNo(inspection.hasAgentsMd)}</dd>
      </dl>

      {inspection.isMainCheckout ? (
        <section aria-label="Docs source">
          <h3 className="mb-2 text-sm font-semibold">Docs source</h3>
          <DocsDetails docs={inspection.docs} />
        </section>
      ) : null}

      {inspection.warnings.length > 0 ? (
        <ul
          className="text-warn flex flex-col gap-1 text-sm"
          aria-label="Warnings"
        >
          {inspection.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ConnectDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (project: ProjectDetail) => void;
}) {
  /** Every runner, unfiltered: the message about what is missing needs them. */
  const [allRunners, setAllRunners] = useState<AdminRunner[]>();
  const [runnerId, setRunnerId] = useState('');
  const [path, setPath] = useState('');
  const [inspection, setInspection] = useState<ProjectInspection>();
  const [error, setError] = useState<string>();
  const [suggested, setSuggested] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath('');
    setInspection(undefined);
    setError(undefined);
    setSuggested(undefined);
    let current = true;
    let failedOnce = false;
    const load = () =>
      api<AdminRunner[]>('/admin/runners')
        .then((list) => {
          if (!current) return;
          failedOnce = false;
          setAllRunners(list);
          const online = list.filter((runner) => isRunnerOnline(runner.status));
          setRunnerId((selected) =>
            online.some((runner) => runner.id === selected)
              ? selected
              : (online[0]?.id ?? ''),
          );
        })
        .catch((err) => {
          // One toast per outage, not one per poll.
          if (current && !failedOnce) toast.error(describeProjectError(err));
          failedOnce = true;
        });
    load();
    // The admin is usually starting the runner in another window.
    const timer = setInterval(load, RUNNERS_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [open]);

  const runners = (allRunners ?? []).filter((runner) =>
    isRunnerOnline(runner.status),
  );
  const fleet = allRunners ? runnersFact(allRunners) : undefined;
  const selected = runners.find((runner) => runner.id === runnerId);

  const inspect = async (event?: FormEvent, usePath = path) => {
    event?.preventDefault();
    const trimmed = usePath.trim();
    if (!runnerId || !trimmed) return;
    setBusy(true);
    setError(undefined);
    setSuggested(undefined);
    setInspection(undefined);
    try {
      const body: InspectProjectRequest = { runnerId, path: trimmed };
      setInspection(
        await api<ProjectInspection>('/admin/projects/inspect', {
          method: 'POST',
          body,
        }),
      );
    } catch (err) {
      setError(describeProjectError(err));
      setSuggested(suggestedPathOf(err));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!inspection) return;
    setBusy(true);
    try {
      const body: ConnectProjectRequest = { runnerId, path: inspection.root };
      onConnected(
        await api<ProjectDetail>('/admin/projects', { method: 'POST', body }),
      );
    } catch (err) {
      setError(describeProjectError(err));
      setSuggested(suggestedPathOf(err));
      setInspection(undefined);
    } finally {
      setBusy(false);
    }
  };

  const blocker = inspection ? connectBlocker(inspection) : null;
  const canInspect = runnerId !== '' && path.trim() !== '';
  // Rule R1: a reason for each disabled button that is not just "busy".
  const reason = busy
    ? null
    : !canInspect
      ? 'Pick a runner and enter a path, then Inspect.'
      : !inspection
        ? 'Inspect the path first; Connect uses what it finds.'
        : null;

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title="Connect project"
        description="Pick a runner and the absolute path of the repository's main checkout on it. Nothing is stored until you connect."
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="glass"
              type="submit"
              form="inspect-project"
              disabled={busy || !canInspect}
              aria-describedby={reason ? REASON_ID : undefined}
            >
              Inspect
            </Button>
            <Button
              variant="solid"
              onClick={connect}
              disabled={busy || !inspection || blocker !== null}
              aria-describedby={reason ? REASON_ID : undefined}
            >
              Connect
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {fleet ? <NoOnlineRunner fleet={fleet} /> : null}
          <form
            id="inspect-project"
            className="flex flex-col gap-3"
            onSubmit={inspect}
          >
            <Field label="Runner" htmlFor="connect-runner" required>
              <Select
                id="connect-runner"
                value={runnerId}
                onChange={(e) => {
                  setRunnerId(e.target.value);
                  setInspection(undefined);
                }}
                disabled={runners.length === 0}
              >
                {runners.length === 0 ? (
                  <option value="">No online runner</option>
                ) : null}
                {runners.map((runner) => (
                  <option key={runner.id} value={runner.id}>
                    {runner.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Path"
              htmlFor="connect-path"
              required
              hint={`Absolute path to an existing clone on ${selected?.hostname ?? selected?.name ?? "the runner's machine"}, e.g. /home/you/dev/my-repo. GitHub repositories only.`}
            >
              <Input
                id="connect-path"
                value={path}
                placeholder="/home/you/dev/my-repo"
                autoFocus
                onChange={(e) => {
                  setPath(e.target.value);
                  setInspection(undefined);
                }}
              />
            </Field>
          </form>

          {error ? (
            <div
              role="alert"
              className="text-danger flex flex-col gap-2 text-sm"
            >
              <span>{error}</span>
              {suggested ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono break-all">{suggested}</span>
                  <Button
                    variant="glass"
                    size="sm"
                    onClick={() => {
                      setPath(suggested);
                      void inspect(undefined, suggested);
                    }}
                  >
                    Use this path
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}

          {inspection ? (
            <>
              {blocker ? (
                <div
                  role="alert"
                  className="text-danger flex flex-wrap items-center gap-2 text-sm"
                >
                  <span>{blocker}</span>
                  {inspection.isMainCheckout ? null : (
                    <Button
                      variant="glass"
                      size="sm"
                      onClick={() => {
                        setPath(inspection.root);
                        void inspect(undefined, inspection.root);
                      }}
                    >
                      Use this path
                    </Button>
                  )}
                </div>
              ) : null}
              <Preview inspection={inspection} />
            </>
          ) : null}

          {reason ? (
            <div className="flex justify-end">
              <DisabledReason id={REASON_ID}>{reason}</DisabledReason>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
