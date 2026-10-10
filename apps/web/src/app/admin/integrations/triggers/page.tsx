'use client';

import type {
  InboundTriggerView,
  InboundTriggerWithSecret,
  ProjectSummary,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { CodeBlock } from 'glass-ui/code-block';
import { EmptyState } from 'glass-ui/empty-state';
import { Skeleton } from 'glass-ui/skeleton';
import { Table, TableCell, TableHead, TableRow } from 'glass-ui/table';
import { toast } from 'glass-ui/toast';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { formatAgo } from '../../../../lib/fleet/format';
import {
  actionSummary,
  curlExample,
  describeWebhooksError,
  INBOUND_STATUS_LABEL,
  INBOUND_STATUS_TONE,
  projectLabel,
} from '../../../../lib/webhooks/format';
import {
  type RevealedSecret,
  SecretDialog,
} from '../../../../lib/webhooks/secret-dialog';
import { TriggerDialog } from './trigger-dialog';
import { TriggerSheet } from './trigger-sheet';

const POLL_MS = 15_000;

/** The caller-facing URL: the API is reached through the web app's `/api` rewrite. */
const hookUrl = (path: string): string =>
  `${window.location.origin}/api${path}`;

function revealTrigger(
  title: string,
  trigger: InboundTriggerWithSecret,
): RevealedSecret {
  return {
    title,
    secret: trigger.secret,
    children: (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-ink-2">
          Send a signed request — the signature is{' '}
          <code className="font-mono">
            HMAC-SHA256(secret,
            "&lt;timestamp&gt;.&lt;delivery&gt;.&lt;body&gt;")
          </code>
          :
        </p>
        <CodeBlock
          language="sh"
          code={curlExample(hookUrl(trigger.path), trigger.secret)}
          wrap
        />
      </div>
    ),
  };
}

export default function AdminTriggersPage() {
  const [triggers, setTriggers] = useState<InboundTriggerView[]>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [editing, setEditing] = useState<InboundTriggerView | 'new'>();
  const [selected, setSelected] = useState<string>();
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  const load = useCallback(async () => {
    try {
      setTriggers(await api<InboundTriggerView[]>('/admin/triggers'));
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

  const selectedTrigger = triggers?.find((t) => t.id === selected);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Triggers</h1>
          <p className="max-w-prose text-sm text-ink-2">
            Inbound webhooks. A signed{' '}
            <code className="font-mono">POST /hooks/&lt;id&gt;</code> starts a
            skill run or <code className="font-mono">orchestrator next</code> on
            one project. Payload values only fill the placeholders you allow,
            and never reach a shell.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>New trigger</Button>
      </div>

      {!triggers ? (
        <Skeleton className="h-48 w-full" />
      ) : triggers.length === 0 ? (
        <EmptyState
          title="No triggers"
          description="Create one to let CI, a deploy hook or another system start work."
        />
      ) : (
        <Table scroll>
          <TableHead>
            <TableRow>
              <TableCell head>Name</TableCell>
              <TableCell head>Project</TableCell>
              <TableCell head>Action</TableCell>
              <TableCell head>State</TableCell>
              <TableCell head>Last delivery</TableCell>
              <TableCell head>
                <span className="sr-only">Actions</span>
              </TableCell>
            </TableRow>
          </TableHead>
          <tbody>
            {triggers.map((trigger) => (
              <TableRow key={trigger.id}>
                <TableCell>
                  <span className="font-medium">{trigger.name}</span>
                </TableCell>
                <TableCell>
                  {projectLabel(trigger.projectId, projects)}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-sm">
                    {actionSummary(trigger.action)}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge
                    tone={trigger.enabled ? 'ok' : 'neutral'}
                    label={trigger.enabled ? 'enabled' : 'disabled'}
                  />
                </TableCell>
                <TableCell>
                  {trigger.lastDelivery ? (
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={INBOUND_STATUS_TONE[trigger.lastDelivery.status]}
                        label={
                          INBOUND_STATUS_LABEL[trigger.lastDelivery.status]
                        }
                      />
                      <span className="text-xs text-ink-3">
                        {formatAgo(trigger.lastDelivery.receivedAt)}
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
                      onClick={() => setSelected(trigger.id)}
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

      <TriggerDialog
        open={editing !== undefined}
        trigger={editing === 'new' ? undefined : editing}
        projects={projects}
        onClose={() => setEditing(undefined)}
        onCreated={(created) => {
          setEditing(undefined);
          setRevealed(revealTrigger('Trigger created', created));
          void load();
        }}
        onSaved={() => {
          setEditing(undefined);
          toast.success('Trigger saved');
          void load();
        }}
      />

      <TriggerSheet
        triggerId={selected}
        projectName={
          selectedTrigger
            ? projectLabel(selectedTrigger.projectId, projects)
            : ''
        }
        onClose={() => setSelected(undefined)}
        onEdit={setEditing}
        onRotated={(rotated) =>
          setRevealed(revealTrigger('Secret rotated', rotated))
        }
        onChanged={() => void load()}
      />

      <SecretDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </div>
  );
}
