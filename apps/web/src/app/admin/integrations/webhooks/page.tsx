'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { EmptyState } from '@andrewbehma/glass-ui/empty-state';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import type {
  ProjectSummary,
  WebhookView,
  WebhookWithSecret,
} from '@nautelle/shared';
import { useEffect, useState } from 'react';
import { PageHeader } from '../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../components/prerequisites/async-section';
import { api } from '../../../../lib/api';
import { Time } from '../../../../lib/format/time';
import { useSection } from '../../../../lib/section/use-section';
import {
  CIRCUIT_LABEL,
  CIRCUIT_TONE,
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TONE,
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
      Receivers verify <code className="font-mono">X-Nautelle-Signature</code>{' '}
      with this secret; the recipe is on the webhook’s detail sheet.
    </p>
  ),
});

export default function AdminWebhooksPage() {
  const webhooks = useSection(() => api<WebhookView[]>('/admin/webhooks'), []);
  const [editing, setEditing] = useState<WebhookView | 'new'>();
  // Only the create/edit dialog needs the project list: fetch it when one opens.
  const projects = useSection(
    () =>
      editing === undefined
        ? new Promise<ProjectSummary[]>(() => undefined)
        : api<ProjectSummary[]>('/projects'),
    [editing === undefined],
  );
  const [selected, setSelected] = useState<string>();
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const reload = webhooks.retry;

  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="Webhooks"
        description="Outbound. Nautelle’s events are pushed to a URL you choose — signed, retried with backoff, and paused for a while when the receiver keeps failing."
        actions={<Button onClick={() => setEditing('new')}>New webhook</Button>}
      />

      <AsyncSection
        section={webhooks}
        unavailable={{
          title: 'Webhooks are not answering',
          stillWorks:
            'Deliveries keep going out on the server; only this list is missing.',
        }}
        skeleton={<Skeleton className="h-48 w-full" />}
        empty={
          <EmptyState
            title="Where Nautelle sends its events"
            description="Create a webhook to send events — pull requests, blocked issues, agents waiting for a person — to n8n, Slack or your own bot. New webhook is at the top of the page."
          />
        }
      >
        {(list) => (
          <Table scroll>
            <TableHead>
              <TableRow>
                <TableCell head>Name</TableCell>
                <TableCell head>Target</TableCell>
                <TableCell head>Events</TableCell>
                <TableCell head>Delivery</TableCell>
                <TableCell head>Last delivery</TableCell>
                <TableCell head>
                  <span className="sr-only">Actions</span>
                </TableCell>
              </TableRow>
            </TableHead>
            <tbody>
              {list.map((webhook) => (
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
                          tone={
                            DELIVERY_STATUS_TONE[webhook.lastDelivery.status]
                          }
                          label={
                            DELIVERY_STATUS_LABEL[webhook.lastDelivery.status]
                          }
                        />
                        <span className="text-xs text-ink-3">
                          <Time value={webhook.lastDelivery.createdAt} />
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
      </AsyncSection>

      <TargetsCard />

      <WebhookDialog
        open={editing !== undefined}
        webhook={editing === 'new' ? undefined : editing}
        projects={projects}
        onClose={() => setEditing(undefined)}
        onCreated={(created) => {
          setEditing(undefined);
          setRevealed(revealWebhook('Webhook created', created));
          reload();
        }}
        onSaved={() => {
          setEditing(undefined);
          toast.success('Webhook saved');
          reload();
        }}
      />

      <WebhookSheet
        webhookId={selected}
        onClose={() => setSelected(undefined)}
        onEdit={setEditing}
        onRotated={(rotated) =>
          setRevealed(revealWebhook('Secret rotated', rotated))
        }
        onChanged={reload}
      />

      <SecretDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </div>
  );
}
