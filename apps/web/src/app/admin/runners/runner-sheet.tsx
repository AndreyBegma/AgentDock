'use client';

import type {
  AdminRunner,
  AdminRunnerDetail,
  PairingCodeResponse,
  PingResult,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { SheetContent, SheetRoot } from '@andrewbehma/glass-ui/sheet';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { DisabledReason } from '../../../components/prerequisites/disabled-reason';
import { api } from '../../../lib/api';
import { Time } from '../../../lib/format/time';
import {
  capabilityRows,
  describeRunnerError,
  formatLoad,
  LOAD_LABEL,
  runnerRemedy,
  STATUS_TONE,
  statusLabel,
} from '../../../lib/runners/format';
import { PROFILES_DETECT_COMMAND } from '../../../lib/runners/install';
import { LocalSettings } from './local-settings';

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
  const remedy = detail ? runnerRemedy(detail) : null;

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
            footer={
              <Button variant="glass" onClick={onClose}>
                Close
              </Button>
            }
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
                    {statusLabel(
                      detail.status,
                      detail.pairedAt,
                      detail.lastSeenAt,
                    )}
                  </span>
                  <span className="text-xs text-ink-3">
                    last seen{' '}
                    <Time value={detail.lastSeenAt} fallback="never" />
                  </span>
                </div>
                {remedy && !isRevoked ? (
                  <p className="text-sm text-ink-2">
                    {remedy.text}
                    {remedy.command ? (
                      <code className="ml-1 font-mono text-ink">
                        {remedy.command}
                      </code>
                    ) : null}
                  </p>
                ) : null}

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
                </div>
                {isRevoked ? (
                  <DisabledReason>
                    This runner is revoked: it cannot reconnect, so it cannot be
                    pinged, re-paired or revoked again. To use the machine
                    again, add a new runner.
                  </DisabledReason>
                ) : null}

                <section aria-labelledby="runner-about">
                  <h3 id="runner-about" className="mb-2 text-sm font-semibold">
                    Runner
                  </h3>
                  <KeyValueList
                    dense
                    items={[
                      {
                        key: 'version',
                        label: 'Version',
                        value: detail.version ?? '—',
                      },
                      {
                        key: 'protocol',
                        label: 'Protocol',
                        value: detail.protocolVersion ?? '—',
                      },
                      {
                        key: 'paired',
                        label: 'Paired',
                        value: (
                          <Time value={detail.pairedAt} fallback="not paired" />
                        ),
                      },
                      {
                        key: 'events',
                        label: 'Events stored',
                        value: `up to #${detail.ackedSeq}`,
                      },
                      ...(detail.heartbeat
                        ? [
                            {
                              key: 'load',
                              label: LOAD_LABEL,
                              value: (
                                <span className="num">
                                  {formatLoad(detail.heartbeat.load)}
                                </span>
                              ),
                            },
                            {
                              key: 'tmux',
                              label: 'tmux sessions',
                              value: detail.heartbeat.tmuxSessions,
                            },
                          ]
                        : []),
                    ]}
                  />
                </section>

                <section aria-labelledby="runner-caps">
                  <h3 id="runner-caps" className="mb-2 text-sm font-semibold">
                    Capabilities
                  </h3>
                  {detail.capabilities ? (
                    <KeyValueList
                      dense
                      items={capabilityRows(detail.capabilities).map((row) => ({
                        key: row.label,
                        label: row.label,
                        value: row.value,
                      }))}
                    />
                  ) : (
                    <p className="text-sm text-ink-3">
                      Reported when the runner connects.
                    </p>
                  )}
                </section>

                <LocalSettings
                  runner={detail}
                  disabled={isRevoked || busy}
                  onChanged={() => {
                    void load();
                    onChanged();
                  }}
                />

                <section aria-labelledby="runner-profiles">
                  <h3
                    id="runner-profiles"
                    className="mb-2 text-sm font-semibold"
                  >
                    Runtime profiles
                  </h3>
                  {detail.profiles.length === 0 ? (
                    <div className="flex flex-col gap-2 text-sm text-ink-2">
                      <p>
                        No profiles reported. A profile is a Claude Code or
                        Codex sign-in the runner can start agents with. Detect
                        and save them on the runner&apos;s machine, then restart
                        the runner:
                      </p>
                      <CodeBlock code={PROFILES_DETECT_COMMAND} />
                    </div>
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
                              <Time value={event.ts} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </section>

                <section
                  aria-labelledby="runner-danger"
                  className="flex flex-col gap-3 rounded-lg border border-danger/40 p-4"
                >
                  <h3
                    id="runner-danger"
                    className="text-sm font-semibold text-danger"
                  >
                    Danger zone
                  </h3>
                  <p className="text-sm text-ink-2">
                    Revoking disconnects the runner now and refuses it when it
                    reconnects. Its row and events stay.
                  </p>
                  <div>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy || isRevoked}
                      onClick={() => setDialog('revoke')}
                    >
                      Revoke runner
                    </Button>
                  </div>
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
