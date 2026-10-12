'use client';

import {
  type InboundDryRunResult,
  type InboundTriggerDetail,
  type InboundTriggerView,
  type InboundTriggerWithSecret,
  WEBHOOK_LIVE_EVENTS,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Banner } from 'glass-ui/banner';
import { Button } from 'glass-ui/button';
import { CodeBlock } from 'glass-ui/code-block';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Textarea } from 'glass-ui/field';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { formatAgo } from '../../../../lib/fleet/format';
import { useLive } from '../../../../lib/live/use-live';
import {
  actionSummary,
  deliveryReasonLabel,
  describeTemplateReason,
  describeWebhooksError,
  INBOUND_STATUS_LABEL,
  INBOUND_STATUS_TONE,
} from '../../../../lib/webhooks/format';

const POLL_MS = 15_000;

type Confirm = 'rotate' | 'delete';

/**
 * One trigger: its state, delivery log, dry run and the actions on it. A
 * rotated secret goes to `onRotated` — this component never keeps it.
 */
export function TriggerSheet({
  triggerId,
  projectName,
  onClose,
  onEdit,
  onRotated,
  onChanged,
}: {
  triggerId: string | undefined;
  projectName: string;
  onClose: () => void;
  onEdit: (trigger: InboundTriggerView) => void;
  onRotated: (rotated: InboundTriggerWithSecret) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<InboundTriggerDetail>();
  const [confirm, setConfirm] = useState<Confirm>();
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState('{\n  \n}');
  const [verdict, setVerdict] = useState<InboundDryRunResult | string>();

  const load = useCallback(async () => {
    if (!triggerId) return;
    try {
      setDetail(
        await api<InboundTriggerDetail>(`/admin/triggers/${triggerId}`),
      );
    } catch (err) {
      toast.error(describeWebhooksError(err));
    }
  }, [triggerId]);

  useEffect(() => {
    setDetail(undefined);
    setVerdict(undefined);
    setConfirm(undefined);
    if (!triggerId) return;
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [triggerId, load]);

  useLive(triggerId ? 'admin' : null, (message) => {
    if (message.event === WEBHOOK_LIVE_EVENTS.inboundDeliveryCreated) {
      void load();
    }
  });

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast.error(describeWebhooksError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = () =>
    act(async () => {
      if (!detail) return;
      await api(`/admin/triggers/${detail.id}`, {
        method: 'PATCH',
        body: { enabled: !detail.enabled },
      });
      toast.success(detail.enabled ? 'Trigger disabled' : 'Trigger enabled');
      await load();
      onChanged();
    });

  const rotate = () =>
    act(async () => {
      if (!detail) return;
      const rotated = await api<InboundTriggerWithSecret>(
        `/admin/triggers/${detail.id}/rotate-secret`,
        { method: 'POST', body: {} },
      );
      setConfirm(undefined);
      onRotated(rotated);
      await load();
      onChanged();
    });

  const remove = () =>
    act(async () => {
      if (!detail) return;
      await api(`/admin/triggers/${detail.id}`, { method: 'DELETE' });
      toast.success('Trigger deleted');
      setConfirm(undefined);
      onClose();
      onChanged();
    });

  const dryRun = () =>
    act(async () => {
      if (!detail) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        setVerdict('The payload is not valid JSON.');
        return;
      }
      setVerdict(
        await api<InboundDryRunResult>(`/admin/triggers/${detail.id}/dry-run`, {
          method: 'POST',
          body: { payload: parsed },
        }),
      );
    });

  return (
    <>
      <SheetRoot
        open={triggerId !== undefined}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {triggerId ? (
          <SheetContent
            side="right"
            title={detail?.name ?? 'Trigger'}
            description={
              detail
                ? `${projectName} · ${actionSummary(detail.action)}`
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
                    tone={detail.enabled ? 'ok' : 'neutral'}
                    label={detail.enabled ? 'enabled' : 'disabled'}
                  />
                  {detail.disabledReason ? (
                    <span className="text-xs text-ink-3">
                      {deliveryReasonLabel(detail.disabledReason)}
                    </span>
                  ) : null}
                  {detail.previousSecretUntil ? (
                    <span className="text-xs text-ink-3">
                      previous secret also valid until{' '}
                      {new Date(detail.previousSecretUntil).toLocaleString()}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={toggleEnabled}
                  >
                    {detail.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => onEdit(detail)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirm('rotate')}
                  >
                    Rotate secret
                  </Button>
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirm('delete')}
                  >
                    Delete
                  </Button>
                </div>

                <section
                  aria-labelledby="trigger-url"
                  className="flex flex-col gap-2"
                >
                  <h3 id="trigger-url" className="text-sm font-semibold">
                    Endpoint
                  </h3>
                  <CodeBlock code={`POST ${detail.path}`} copy={false} />
                  <p className="text-xs text-ink-3">
                    The path is relative to the API’s public URL. Sign every
                    request with the trigger’s secret; the secret itself is
                    never shown again.
                  </p>
                </section>

                <section
                  aria-labelledby="trigger-dry"
                  className="flex flex-col gap-2"
                >
                  <h3 id="trigger-dry" className="text-sm font-semibold">
                    Dry run
                  </h3>
                  <Field
                    label="Payload (JSON)"
                    htmlFor="trigger-dry-payload"
                    hint="The same verdict as a real delivery. Nothing fires."
                  >
                    <Textarea
                      id="trigger-dry-payload"
                      rows={5}
                      className="font-mono"
                      value={payload}
                      onChange={(e) => setPayload(e.target.value)}
                    />
                  </Field>
                  <div>
                    <Button
                      variant="glass"
                      size="sm"
                      disabled={busy}
                      onClick={dryRun}
                    >
                      Render args
                    </Button>
                  </div>
                  {typeof verdict === 'string' ? (
                    <Banner tone="danger">{verdict}</Banner>
                  ) : verdict?.ok ? (
                    <Banner tone="ok" title="Would fire">
                      {verdict.args === null ? (
                        'No args (orchestrator next).'
                      ) : (
                        <code className="break-all font-mono text-xs">
                          {verdict.args}
                        </code>
                      )}
                    </Banner>
                  ) : verdict ? (
                    <Banner tone="danger" title="Would be refused (422)">
                      {describeTemplateReason(verdict.reason, verdict.path)}
                    </Banner>
                  ) : null}
                </section>

                <section
                  aria-labelledby="trigger-log"
                  className="flex flex-col gap-2"
                >
                  <h3 id="trigger-log" className="text-sm font-semibold">
                    Deliveries
                  </h3>
                  {detail.deliveries.length === 0 ? (
                    <EmptyState
                      title="No deliveries yet"
                      description="Signed requests to this trigger are listed here for 30 days."
                    />
                  ) : (
                    <Table scroll>
                      <TableHead>
                        <TableRow>
                          <TableCell head>Received</TableCell>
                          <TableCell head>Status</TableCell>
                          <TableCell head>Delivery</TableCell>
                        </TableRow>
                      </TableHead>
                      <tbody>
                        {detail.deliveries.map((d) => (
                          <TableRow key={d.id}>
                            <TableCell>{formatAgo(d.receivedAt)}</TableCell>
                            <TableCell>
                              <Badge
                                tone={INBOUND_STATUS_TONE[d.status]}
                                label={INBOUND_STATUS_LABEL[d.status]}
                              />
                              {d.reason ? (
                                <div className="text-xs text-ink-3">
                                  {deliveryReasonLabel(d.reason)}
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <span className="font-mono text-xs">
                                {d.deliveryId}
                              </span>
                              {d.sourceIp ? (
                                <div className="text-xs text-ink-3">
                                  {d.sourceIp}
                                </div>
                              ) : null}
                              {d.renderedArgs !== null &&
                              d.renderedArgs !== undefined ? (
                                <div className="break-all font-mono text-xs text-ink-3">
                                  {typeof d.renderedArgs === 'string'
                                    ? d.renderedArgs
                                    : JSON.stringify(d.renderedArgs)}
                                </div>
                              ) : null}
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
        open={confirm !== undefined}
        onOpenChange={(open) => !open && !busy && setConfirm(undefined)}
      >
        <DialogContent
          title={confirm === 'rotate' ? 'Rotate secret' : 'Delete trigger'}
          description={
            confirm === 'rotate'
              ? 'A new secret is generated and shown once. The previous secret keeps verifying for 24 hours.'
              : 'The trigger and its delivery log are removed; its URL starts answering 404. This is audited.'
          }
          footer={
            <>
              <Button
                variant="glass"
                disabled={busy}
                onClick={() => setConfirm(undefined)}
              >
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={confirm === 'rotate' ? rotate : remove}
              >
                {confirm === 'rotate' ? 'Rotate' : 'Delete'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            {confirm === 'delete'
              ? 'This cannot be undone.'
              : 'Update your caller soon.'}
          </p>
        </DialogContent>
      </DialogRoot>
    </>
  );
}
