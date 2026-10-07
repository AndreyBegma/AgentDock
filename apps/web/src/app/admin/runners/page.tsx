'use client';

import type { AdminRunner, PairingCodeResponse } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input } from 'glass-ui/field';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  describeRunnerError,
  formatLastSeen,
  STATUS_TONE,
  statusLabel,
} from '../../../lib/runners/format';
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

function RunnersTable() {
  const [runners, setRunners] = useState<AdminRunner[]>();
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<PairingCodeResponse | null>(null);
  const [selected, setSelected] = useState<string>();

  const load = useCallback(async () => {
    try {
      setRunners(await api<AdminRunner[]>('/admin/runners'));
    } catch (err) {
      toast.error(describeRunnerError(err));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

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
        <h1 className="text-xl font-semibold">Runners</h1>
        <Button variant="solid" onClick={() => setAdding(true)}>
          Add runner
        </Button>
      </div>

      {runners && runners.length === 0 ? (
        <EmptyState
          title="No runners yet"
          description="Add a runner, then run the pairing command it gives you on the machine."
        />
      ) : (
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
            {(runners ?? []).map((runner) => (
              <TableRow key={runner.id}>
                <TableCell>{runner.name}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <Badge
                      dot
                      tone={STATUS_TONE[runner.status]}
                      aria-hidden="true"
                    />
                    {statusLabel(runner.status, runner.pairedAt)}
                  </span>
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
                      onClick={() => setSelected(runner.id)}
                    >
                      Details
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      <AddRunnerDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={showCode}
      />
      <PairingDialog
        result={pairing}
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
