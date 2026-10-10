'use client';

import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_LIVE_EVENTS,
  type WebhookDeliveryPage,
  type WebhookDeliveryStatus,
  type WebhookDeliveryView,
  type WebhookView,
  type WebhookWithSecret,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { CodeBlock } from 'glass-ui/code-block';
import { DialogContent, DialogRoot } from 'glass-ui/dialog';
import { EmptyState } from 'glass-ui/empty-state';
import { Field, Select } from 'glass-ui/field';
import { SheetContent, SheetRoot } from 'glass-ui/sheet';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { formatAgo } from '../../../../lib/fleet/format';
import { useLive } from '../../../../lib/live/use-live';
import {
  attemptErrorLabel,
  CIRCUIT_LABEL,
  CIRCUIT_TONE,
  circuitReopensIn,
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TONE,
  describeWebhooksError,
  VERIFY_SAMPLE,
} from '../../../../lib/webhooks/format';

const POLL_MS = 15_000;

type Confirm = 'rotate' | 'delete';

const asStatus = (value: string): WebhookDeliveryStatus | '' =>
  WEBHOOK_DELIVERY_STATUSES.find((s) => s === value) ?? '';

/**
 * One webhook: circuit state, actions, delivery log and the verification
 * sample. A rotated secret goes to `onRotated` — never kept here.
 */
export function WebhookSheet({
  webhookId,
  onClose,
  onEdit,
  onRotated,
  onChanged,
}: {
  webhookId: string | undefined;
  onClose: () => void;
  onEdit: (webhook: WebhookView) => void;
  onRotated: (rotated: WebhookWithSecret) => void;
  onChanged: () => void;
}) {
  const [webhook, setWebhook] = useState<WebhookView>();
  const [deliveries, setDeliveries] = useState<WebhookDeliveryView[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<WebhookDeliveryStatus | ''>('');
  const [confirm, setConfirm] = useState<Confirm>();
  const [busy, setBusy] = useState(false);

  const logPath = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      const query = params.toString();
      return `/admin/webhooks/${webhookId}/deliveries${query ? `?${query}` : ''}`;
    },
    [webhookId, status],
  );

  const load = useCallback(async () => {
    if (!webhookId) return;
    try {
      const [view, page] = await Promise.all([
        api<WebhookView>(`/admin/webhooks/${webhookId}`),
        api<WebhookDeliveryPage>(logPath()),
      ]);
      setWebhook(view);
      setDeliveries(page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast.error(describeWebhooksError(err));
    }
  }, [webhookId, logPath]);

  useEffect(() => {
    if (!webhookId) {
      setWebhook(undefined);
      setDeliveries(undefined);
      setConfirm(undefined);
      return;
    }
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [webhookId, load]);

  useLive(webhookId ? 'admin' : null, (message) => {
    if (message.event === WEBHOOK_LIVE_EVENTS.deliveryUpdated) void load();
  });

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const page = await api<WebhookDeliveryPage>(logPath(nextCursor));
      setDeliveries((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast.error(describeWebhooksError(err));
    }
  };

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

  const post = (path: string, done: string) =>
    act(async () => {
      await api(`/admin/webhooks/${webhookId}${path}`, {
        method: 'POST',
        body: {},
      });
      toast.success(done);
      await load();
      onChanged();
    });

  const toggleEnabled = () =>
    act(async () => {
      if (!webhook) return;
      await api(`/admin/webhooks/${webhook.id}`, {
        method: 'PATCH',
        body: { enabled: !webhook.enabled },
      });
      toast.success(webhook.enabled ? 'Webhook disabled' : 'Webhook enabled');
      await load();
      onChanged();
    });

  const rotate = () =>
    act(async () => {
      const rotated = await api<WebhookWithSecret>(
        `/admin/webhooks/${webhookId}/rotate-secret`,
        { method: 'POST', body: {} },
      );
      setConfirm(undefined);
      onRotated(rotated);
      await load();
      onChanged();
    });

  const remove = () =>
    act(async () => {
      await api(`/admin/webhooks/${webhookId}`, { method: 'DELETE' });
      toast.success('Webhook deleted');
      setConfirm(undefined);
      onClose();
      onChanged();
    });

  const reopens = webhook ? circuitReopensIn(webhook) : null;

  return (
    <>
      <SheetRoot
        open={webhookId !== undefined}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {webhookId ? (
          <SheetContent
            side="right"
            title={webhook?.name ?? 'Webhook'}
            description={webhook?.url}
          >
            {!webhook ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={webhook.enabled ? 'ok' : 'neutral'}
                    label={webhook.enabled ? 'enabled' : 'disabled'}
                  />
                  <Badge
                    tone={CIRCUIT_TONE[webhook.circuitState]}
                    label={`circuit ${CIRCUIT_LABEL[webhook.circuitState]}`}
                  />
                  {reopens ? (
                    <span className="text-xs text-ink-3">{reopens}</span>
                  ) : null}
                  {webhook.consecutiveFailures > 0 ? (
                    <span className="text-xs text-ink-3">
                      {webhook.consecutiveFailures} consecutive failures
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => post('/test', 'Test delivery queued')}
                  >
                    Test
                  </Button>
                  {webhook.circuitState !== 'closed' ? (
                    <Button
                      variant="glass"
                      size="sm"
                      disabled={busy}
                      onClick={() => post('/close-circuit', 'Circuit closed')}
                    >
                      Close circuit
                    </Button>
                  ) : null}
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={toggleEnabled}
                  >
                    {webhook.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="glass"
                    size="sm"
                    disabled={busy}
                    onClick={() => onEdit(webhook)}
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
                  aria-labelledby="webhook-log"
                  className="flex flex-col gap-2"
                >
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <h3 id="webhook-log" className="text-sm font-semibold">
                      Deliveries
                    </h3>
                    <Field label="Status" htmlFor="webhook-log-status">
                      <Select
                        id="webhook-log-status"
                        value={status}
                        onChange={(e) => setStatus(asStatus(e.target.value))}
                      >
                        <option value="">All</option>
                        {WEBHOOK_DELIVERY_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {DELIVERY_STATUS_LABEL[s]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  {!deliveries ? (
                    <Skeleton className="h-24 w-full" />
                  ) : deliveries.length === 0 ? (
                    <EmptyState
                      title="No deliveries"
                      description="Use Test to send a webhook.test event."
                    />
                  ) : (
                    <Table scroll>
                      <TableHead>
                        <TableRow>
                          <TableCell head>Event</TableCell>
                          <TableCell head>Status</TableCell>
                          <TableCell head>Attempts</TableCell>
                          <TableCell head>Next attempt</TableCell>
                          <TableCell head>
                            <span className="sr-only">Actions</span>
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <tbody>
                        {deliveries.map((d) => (
                          <TableRow key={d.id}>
                            <TableCell>
                              <span className="font-mono text-sm">
                                {d.eventType}
                              </span>
                              <div className="text-xs text-ink-3">
                                {formatAgo(d.createdAt)}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                tone={DELIVERY_STATUS_TONE[d.status]}
                                label={DELIVERY_STATUS_LABEL[d.status]}
                              />
                              <div className="text-xs text-ink-3">
                                {d.responseCode !== null
                                  ? `HTTP ${d.responseCode}`
                                  : ''}
                                {d.error
                                  ? ` ${attemptErrorLabel(d.error)}`
                                  : ''}
                              </div>
                            </TableCell>
                            <TableCell>{d.attempts}</TableCell>
                            <TableCell>
                              {d.status === 'pending'
                                ? new Date(d.nextAttemptAt).toLocaleTimeString()
                                : '—'}
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end">
                                <Button
                                  variant="glass"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    post(
                                      `/deliveries/${d.id}/redeliver`,
                                      'Redelivery queued',
                                    )
                                  }
                                >
                                  Redeliver
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </tbody>
                    </Table>
                  )}
                  {nextCursor ? (
                    <div>
                      <Button variant="glass" size="sm" onClick={loadMore}>
                        Load older
                      </Button>
                    </div>
                  ) : null}
                </section>

                <section
                  aria-labelledby="webhook-verify"
                  className="flex flex-col gap-2"
                >
                  <h3 id="webhook-verify" className="text-sm font-semibold">
                    Verifying a delivery
                  </h3>
                  <p className="text-xs text-ink-3">
                    Each request carries{' '}
                    <code className="font-mono">
                      X-AgentDock-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;
                    </code>
                    , where hex is HMAC-SHA256 of{' '}
                    <code className="font-mono">
                      &lt;t&gt;.&lt;raw body&gt;
                    </code>{' '}
                    with the secret. Compare in constant time over the raw
                    bytes.
                  </p>
                  <CodeBlock language="js" code={VERIFY_SAMPLE} />
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
          title={confirm === 'rotate' ? 'Rotate secret' : 'Delete webhook'}
          description={
            confirm === 'rotate'
              ? 'A new secret is generated and shown once. Signing switches to it immediately — the old secret stops verifying.'
              : 'The webhook and its delivery log are removed. This is audited.'
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
              : 'Update your receiver right after.'}
          </p>
        </DialogContent>
      </DialogRoot>
    </>
  );
}
