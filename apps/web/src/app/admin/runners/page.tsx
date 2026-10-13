'use client';

import type { AdminRunner, PairingCodeResponse } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input } from 'glass-ui/field';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useEffect, useState } from 'react';
import { AsyncSection } from '../../../components/prerequisites/async-section';
import { api } from '../../../lib/api';
import {
  describeRunnerError,
  formatLastSeen,
  runnerRemedy,
  STATUS_TONE,
  statusLabel,
} from '../../../lib/runners/format';
import { useSection } from '../../../lib/section/use-section';
import { PairingDialog } from './pairing-dialog';
import { RunnerSheet } from './runner-sheet';

/** The page polls; live updates over WebSocket come with M1.8 (spec). */
const POLL_MS = 10_000;

function AddRunnerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: PairingCodeResponse) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      onCreated(
        await api<PairingCodeResponse>('/admin/runners', {
          method: 'POST',
          body: { name: trimmed },
        }),
      );
    } catch (err) {
      toast.error(describeRunnerError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title="Add runner"
        description="Name the machine. You get a one-time pairing code to run on it."
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="solid"
              type="submit"
              form="add-runner"
              disabled={busy || !name.trim()}
            >
              Create
            </Button>
          </>
        }
      >
        <form id="add-runner" onSubmit={submit}>
          <Field label="Name" htmlFor="add-runner-name" required>
            <Input
              id="add-runner-name"
              value={name}
              maxLength={100}
              placeholder="e.g. build-box"
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

/** Status, and for a runner that is not online, the next step under it. */
function StatusCell({ runner }: { runner: AdminRunner }) {
  const remedy = runnerRemedy(runner);
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        <Badge dot tone={STATUS_TONE[runner.status]} aria-hidden="true" />
        {statusLabel(runner.status, runner.pairedAt, runner.lastSeenAt)}
      </span>
      {remedy ? (
        <span className="text-xs text-ink-2">
          {remedy.text}
          {remedy.command ? (
            <code className="ml-1 font-mono text-ink">{remedy.command}</code>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function RunnerRows({
  runners,
  onDetails,
}: {
  runners: AdminRunner[];
  onDetails: (id: string) => void;
}) {
  return (
    <Table scroll>
      <TableHead>
        <TableRow>
          <TableCell head>Name</TableCell>
          <TableCell head>Status</TableCell>
          <TableCell head>Hostname</TableCell>
          <TableCell head>Version</TableCell>
          <TableCell head>Profiles</TableCell>
          <TableCell head>Last seen</TableCell>
          <TableCell head>
            <span className="sr-only">Actions</span>
          </TableCell>
        </TableRow>
      </TableHead>
      <tbody>
        {runners.map((runner) => (
          <TableRow key={runner.id}>
            <TableCell>{runner.name}</TableCell>
            <TableCell>
              <StatusCell runner={runner} />
            </TableCell>
            <TableCell>{runner.hostname ?? '—'}</TableCell>
            <TableCell>{runner.version ?? '—'}</TableCell>
            <TableCell>{runner.profilesCount}</TableCell>
            <TableCell>{formatLastSeen(runner.lastSeenAt)}</TableCell>
            <TableCell>
              <div className="flex justify-end">
                <Button
                  variant="glass"
                  size="sm"
                  aria-label={`Details for ${runner.name}`}
                  onClick={() => onDetails(runner.id)}
                >
                  Details
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}

function RunnersTable() {
  const section = useSection(() => api<AdminRunner[]>('/admin/runners'), []);
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<PairingCodeResponse | null>(null);
  const [selected, setSelected] = useState<string>();

  const load = section.retry;
  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The pairing dialog follows its runner through this page's poll.
  const pairingRunner = pairing
    ? section.data?.find((runner) => runner.id === pairing.runner.id)
    : undefined;

  const showCode = (result: PairingCodeResponse) => {
    setAdding(false);
    setPairing(result);
    load();
  };

  // Called from the pairing dialog once its code has expired.
  const reissue = async (runnerId: string) => {
    try {
      showCode(
        await api<PairingCodeResponse>(
          `/admin/runners/${runnerId}/pairing-code`,
          { method: 'POST' },
        ),
      );
    } catch (err) {
      toast.error(describeRunnerError(err));
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Runners</h1>
          <p className="text-sm text-ink-2">
            The AgentDock daemon on each machine that holds your repositories.
          </p>
        </div>
        <Button variant="solid" onClick={() => setAdding(true)}>
          Add runner
        </Button>
      </div>

      <AsyncSection
        section={section}
        unavailable={{ title: 'Runners are not answering' }}
        empty={
          <EmptyState
            title="Pair your first runner"
            description="A runner is the AgentDock daemon on the machine that holds your repositories: it runs the agents and reads the code, and it dials out to AgentDock, so the machine needs no open port. Add one to get a pairing command to run there."
            action={
              <Button variant="solid" size="sm" onClick={() => setAdding(true)}>
                Add runner
              </Button>
            }
          />
        }
      >
        {(runners) => <RunnerRows runners={runners} onDetails={setSelected} />}
      </AsyncSection>

      <AddRunnerDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={showCode}
      />
      <PairingDialog
        result={pairing}
        runner={pairingRunner}
        onClose={() => setPairing(null)}
        onNewCode={reissue}
      />
      <RunnerSheet
        runnerId={selected}
        onClose={() => setSelected(undefined)}
        onChanged={load}
        onPairing={setPairing}
      />
    </>
  );
}

export default function AdminRunnersPage() {
  return <RunnersTable />;
}
