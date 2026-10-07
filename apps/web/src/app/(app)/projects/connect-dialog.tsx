'use client';

import type {
  AdminRunner,
  ConnectProjectRequest,
  InspectProjectRequest,
  ProjectDetail,
} from '@agentdock/shared';
import type { ProjectInspection } from '@agentdock/shared/protocol';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { Field, Input, Select } from 'glass-ui/field';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  BASE_SOURCE_LABEL,
  connectBlocker,
  describeProjectError,
  suggestedPathOf,
} from '../../../lib/projects/format';
import { DocsDetails } from './docs-details';

const yesNo = (value: boolean) => (value ? 'found' : 'not found');

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
          {codeSentinelConfig.error
            ? `invalid: ${codeSentinelConfig.error}`
            : codeSentinelConfig.orchestrator
              ? 'found'
              : 'not found'}
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
  const [runners, setRunners] = useState<AdminRunner[]>([]);
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
    api<AdminRunner[]>('/admin/runners')
      .then((list) => {
        const online = list.filter((runner) => runner.status === 'online');
        setRunners(online);
        setRunnerId((current) =>
          online.some((runner) => runner.id === current)
            ? current
            : (online[0]?.id ?? ''),
        );
      })
      .catch((err) => toast.error(describeProjectError(err)));
  }, [open]);

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
              disabled={busy || !runnerId || !path.trim()}
            >
              Inspect
            </Button>
            <Button
              variant="solid"
              onClick={connect}
              disabled={busy || !inspection || blocker !== null}
            >
              Connect
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
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
              hint="Absolute path on the runner's machine."
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
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
