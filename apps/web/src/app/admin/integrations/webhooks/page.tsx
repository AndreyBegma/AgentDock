'use client';

import type {
  ProjectSummary,
  WebhookView,
  WebhookWithSecret,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { formatAgo } from '../../../../lib/fleet/format';
import {
  CIRCUIT_LABEL,
  CIRCUIT_TONE,
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TONE,
  describeWebhooksError,
  eventsLabel,
  urlHost,
} from '../../../../lib/webhooks/format';
import {
  type RevealedSecret,
  SecretDialog,
} from '../../../../lib/webhooks/secret-dialog';
import { TargetsCard } from './targets-card';
import { WebhookDialog } from './webhook-dialog';
import { WebhookSheet } from './webhook-sheet';

const POLL_MS = 15_000;

const revealWebhook = (
  title: string,
  webhook: WebhookWithSecret,
): RevealedSecret => ({
  title,
  secret: webhook.secret,
  children: (
    <p className="text-sm text-ink-2">
      Receivers verify <code className="font-mono">X-AgentDock-Signature</code>{' '}
      with this secret; the recipe is on the webhook’s detail sheet.
    </p>
  ),
});

export default function AdminWebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookView[]>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [editing, setEditing] = useState<WebhookView | 'new'>();
  const [selected, setSelected] = useState<string>();
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  const load = useCallback(async () => {
    try {
      setWebhooks(await api<WebhookView[]>('/admin/webhooks'));
    } catch (err) {
      toast.error(describeWebhooksError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    api<ProjectSummary[]>('/projects')
      .then(setProjects)
      .catch(() => undefined);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Webhooks</h1>
          <p className="max-w-prose text-sm text-ink-2">
            Outbound. AgentDock’s events are pushed to a URL you choose —
            signed, retried with backoff, and held by a circuit breaker while
            the receiver is down.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>New webhook</Button>
      </div>

      {!webhooks ? (
        <Skeleton className="h-48 w-full" />
      ) : webhooks.length === 0 ? (
        <EmptyState
          title="No webhooks"
          description="Create one to send events to n8n, Slack or your own bot."
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Name</TableCell>
              <TableCell head>Target</TableCell>
              <TableCell head>Events</TableCell>
              <TableCell head>Circuit</TableCell>
              <TableCell head>Last delivery</TableCell>
              <TableCell head>
                <span className="sr-only">Actions</span>
              </TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {webhooks.map((webhook) => (
              <TableRow key={webhook.id}>
                <TableCell>
                  <span className="font-medium">{webhook.name}</span>
                  {webhook.enabled ? null : (
                    <div className="text-xs text-ink-3">disabled</div>
                  )}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-sm">
                    {urlHost(webhook.url)}
                  </span>
                </TableCell>
                <TableCell>{eventsLabel(webhook.events)}</TableCell>
                <TableCell>
                  <Badge
                    tone={CIRCUIT_TONE[webhook.circuitState]}
                    label={CIRCUIT_LABEL[webhook.circuitState]}
                  />
                </TableCell>
                <TableCell>
                  {webhook.lastDelivery ? (
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={DELIVERY_STATUS_TONE[webhook.lastDelivery.status]}
                        label={
                          DELIVERY_STATUS_LABEL[webhook.lastDelivery.status]
                        }
                      />
                      <span className="text-xs text-ink-3">
                        {formatAgo(webhook.lastDelivery.createdAt)}
                      </span>
                    </div>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button
                      variant="glass"
                      size="sm"
                      onClick={() => setSelected(webhook.id)}
                    >
                      Open
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      <TargetsCard />

      <WebhookDialog
        open={editing !== undefined}
        webhook={editing === 'new' ? undefined : editing}
        projects={projects}
        onClose={() => setEditing(undefined)}
        onCreated={(created) => {
          setEditing(undefined);
          setRevealed(revealWebhook('Webhook created', created));
          void load();
        }}
        onSaved={() => {
          setEditing(undefined);
          toast.success('Webhook saved');
          void load();
        }}
      />

      <WebhookSheet
        webhookId={selected}
        onClose={() => setSelected(undefined)}
        onEdit={setEditing}
        onRotated={(rotated) =>
          setRevealed(revealWebhook('Secret rotated', rotated))
        }
        onChanged={() => void load()}
      />

      <SecretDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </div>
  );
}
