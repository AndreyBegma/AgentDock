'use client';

import type {
  AdminRunner,
  AdminRunnerDetail,
  PairingCodeResponse,
  PingResult,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Input } from 'glass-ui/field';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import {
  capabilityRows,
  describeRunnerError,
  formatLastSeen,
  STATUS_TONE,
  statusLabel,
} from '../../../lib/runners/format';

const POLL_MS = 10_000;

type Dialog = 'rename' | 'revoke' | undefined;

function pingMessage(result: PingResult): { ok: boolean; text: string } {
  switch (result.status) {
    case 'ok':
      return { ok: true, text: `Pong in ${result.rttMs} ms.` };
    case 'error':
      return {
        ok: false,
        text: `The runner refused the ping: ${result.error.message ?? result.error.code}.`,
      };
    case 'unknown':
      return {
        ok: false,
        text: 'No answer — the runner is offline or did not respond in time.',
      };
  }
}

export function RunnerSheet({
  runnerId,
  onClose,
  onChanged,
  onPairing,
}: {
  runnerId: string | undefined;
  onClose: () => void;
  /** The list should reload: something about the runner changed. */
  onChanged: () => void;
  onPairing: (result: PairingCodeResponse) => void;
}) {
  const [detail, setDetail] = useState<AdminRunnerDetail>();
  const [dialog, setDialog] = useState<Dialog>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!runnerId) return;
    try {
      setDetail(await api<AdminRunnerDetail>(`/admin/runners/${runnerId}`));
    } catch (err) {
      toast.error(describeRunnerError(err));
    }
  }, [runnerId]);

  useEffect(() => {
    setDetail(undefined);
    if (!runnerId) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [runnerId, load]);

  const act = async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await task();
    } catch (err) {
      toast.error(describeRunnerError(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const ping = async () => {
    const result = await act(() =>
      api<PingResult>(`/admin/runners/${runnerId}/ping`, { method: 'POST' }),
    );
    if (!result) return;
    const { ok, text } = pingMessage(result);
    if (ok) toast.success(text);
    else toast.error(text);
  };

  const newCode = async () => {
    const result = await act(() =>
      api<PairingCodeResponse>(`/admin/runners/${runnerId}/pairing-code`, {
        method: 'POST',
      }),
    );
    if (!result) return;
    onPairing(result);
    await load();
    onChanged();
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated = await act(() =>
      api<AdminRunner>(`/admin/runners/${runnerId}`, {
        method: 'PATCH',
        body: { name: trimmed },
      }),
    );
    setDialog(undefined);
    if (updated) {
      await load();
      onChanged();
    }
  };

  const revoke = async () => {
    const revoked = await act(() =>
      api<AdminRunner>(`/admin/runners/${runnerId}/revoke`, {
        method: 'POST',
      }),
    );
    setDialog(undefined);
    if (revoked) {
      toast.success(`${revoked.name} revoked.`);
      await load();
      onChanged();
    }
  };

  const isRevoked = detail?.status === 'revoked';

  return (
    <>
      <SheetRoot
        open={runnerId !== undefined}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {runnerId ? (
          <SheetContent
            side="right"
            title={detail?.name ?? 'Runner'}
            description={
              detail
                ? [detail.hostname, detail.os && `${detail.os}/${detail.arch}`]
                    .filter(Boolean)
                    .join(' · ') || undefined
                : undefined
            }
          >
            {!detail ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    dot
                    tone={STATUS_TONE[detail.status]}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium">
                    {statusLabel(detail.status, detail.pairedAt)}
                  </span>
                  <span className="text-xs text-ink-3">
                    last seen {formatLastSeen(detail.lastSeenAt)}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy || isRevoked}
                    onClick={ping}
                  >
                    Ping
                  </Button>
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setName(detail.name);
                      setDialog('rename');
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy || isRevoked}
                    onClick={newCode}
                  >
                    New pairing code
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy || isRevoked}
                    onClick={() => setDialog('revoke')}
                  >
                    Revoke
                  </Button>
                </div>

                <section aria-labelledby="runner-about">
                  <h3 id="runner-about" className="mb-2 text-sm font-semibold">
                    Runner
                  </h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-ink-3">Version</dt>
                    <dd>{detail.version ?? '—'}</dd>
                    <dt className="text-ink-3">Protocol</dt>
                    <dd>{detail.protocolVersion ?? '—'}</dd>
                    <dt className="text-ink-3">Paired</dt>
                    <dd>
                      {detail.pairedAt
                        ? new Date(detail.pairedAt).toLocaleString()
                        : 'not paired'}
                    </dd>
                    <dt className="text-ink-3">Events stored</dt>
                    <dd>up to #{detail.ackedSeq}</dd>
                    {detail.heartbeat ? (
                      <>
                        <dt className="text-ink-3">Load</dt>
                        <dd>{detail.heartbeat.load.join(' / ')}</dd>
                        <dt className="text-ink-3">tmux sessions</dt>
                        <dd>{detail.heartbeat.tmuxSessions}</dd>
                      </>
                    ) : null}
                  </dl>
                </section>

                <section aria-labelledby="runner-caps">
                  <h3 id="runner-caps" className="mb-2 text-sm font-semibold">
                    Capabilities
                  </h3>
                  {detail.capabilities ? (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      {capabilityRows(detail.capabilities).map((row) => (
                        <div key={row.label} className="contents">
                          <dt className="text-ink-3">{row.label}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-sm text-ink-3">
                      Reported when the runner connects.
                    </p>
                  )}
                </section>

                <section aria-labelledby="runner-profiles">
                  <h3
                    id="runner-profiles"
                    className="mb-2 text-sm font-semibold"
                  >
                    Runtime profiles
                  </h3>
                  {detail.profiles.length === 0 ? (
                    <p className="text-sm text-ink-3">No profiles reported.</p>
                  ) : (
                    <Table scroll>
                      <TableHead>
                        <TableRow>
                          <TableCell head>Profile</TableCell>
                          <TableCell head>Runtime</TableCell>
                          <TableCell head>Auth</TableCell>
                        </TableRow>
                      </TableHead>
                      <tbody>
                        {detail.profiles.map((profile) => (
                          <TableRow key={profile.id}>
                            <TableCell>
                              {profile.label}
                              {profile.missing ? (
                                <Badge
                                  className="ml-2"
                                  tone="warn"
                                  label="missing"
                                />
                              ) : null}
                            </TableCell>
                            <TableCell>{profile.runtime}</TableCell>
                            <TableCell>
                              {profile.authenticated
                                ? 'signed in'
                                : 'not signed in'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </section>

                <section aria-labelledby="runner-events">
                  <h3 id="runner-events" className="mb-2 text-sm font-semibold">
                    Recent events
                  </h3>
                  {detail.events.length === 0 ? (
                    <EmptyState title="No events yet" />
                  ) : (
                    <Table scroll>
                      <TableHead>
                        <TableRow>
                          <TableCell head>#</TableCell>
                          <TableCell head>Type</TableCell>
                          <TableCell head>Source</TableCell>
                          <TableCell head>Time</TableCell>
                        </TableRow>
                      </TableHead>
                      <tbody>
                        {detail.events.map((event) => (
                          <TableRow key={event.seq}>
                            <TableCell>{event.seq}</TableCell>
                            <TableCell>{event.type}</TableCell>
                            <TableCell>{event.source}</TableCell>
                            <TableCell>
                              {new Date(event.ts).toLocaleTimeString()}
                            </TableCell>
                          </TableRow>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </section>
              </div>
            )}
          </SheetContent>
        ) : null}
      </SheetRoot>

      <DialogRoot
        open={dialog === 'rename'}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
      >
        <DialogContent
          title="Rename runner"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(undefined)}>
                Cancel
              </Button>
              <Button
                variant="solid"
                type="submit"
                form="rename-runner"
                disabled={busy || !name.trim()}
              >
                Save
              </Button>
            </>
          }
        >
          <form id="rename-runner" onSubmit={rename}>
            <Field label="Name" htmlFor="rename-runner-name">
              <Input
                id="rename-runner-name"
                value={name}
                maxLength={100}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          </form>
        </DialogContent>
      </DialogRoot>

      <DialogRoot
        open={dialog === 'revoke'}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
      >
        <DialogContent
          title="Revoke runner"
          description={`${detail?.name ?? 'This runner'} will be disconnected now and refused when it reconnects. Its row and events stay. To use the machine again, pair a new runner.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(undefined)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={revoke}>
                Revoke
              </Button>
            </>
          }
        >
          {null}
        </DialogContent>
      </DialogRoot>
    </>
  );
}
