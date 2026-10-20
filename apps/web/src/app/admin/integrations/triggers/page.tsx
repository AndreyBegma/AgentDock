'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
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
  InboundTriggerView,
  InboundTriggerWithSecret,
  ProjectSummary,
} from '@nautelle/shared';
import { useEffect, useState } from 'react';
import { PageHeader } from '../../../../components/page-header/page-header';
import { AsyncSection } from '../../../../components/prerequisites/async-section';
import { api } from '../../../../lib/api';
import { Time } from '../../../../lib/format/time';
import { useSection } from '../../../../lib/section/use-section';
import { triggerUrl } from '../../../../lib/webhooks/events';
import {
  actionSummary,
  curlExample,
  deliveryReasonLabel,
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

const hookUrl = (path: string): string =>
  triggerUrl(window.location.origin, path);

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
  const triggers = useSection(
    () => api<InboundTriggerView[]>('/admin/triggers'),
    [],
  );
  const projects = useSection(() => api<ProjectSummary[]>('/projects'), []);
  const [editing, setEditing] = useState<InboundTriggerView | 'new'>();
  const [selected, setSelected] = useState<string>();
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const reload = triggers.retry;
  const projectList = projects.data ?? [];

  useEffect(() => {
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const selectedTrigger = triggers.data?.find((t) => t.id === selected);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        title="Triggers"
        description={
          <>
            Inbound webhooks. A signed{' '}
            <code className="font-mono">POST /hooks/&lt;id&gt;</code> starts a
            skill run or the next orchestrator round on one project. Payload
            values only fill the placeholders you allow, and never reach a
            shell.
          </>
        }
        actions={<Button onClick={() => setEditing('new')}>New trigger</Button>}
      />

      <AsyncSection
        section={triggers}
        unavailable={{
          title: 'Triggers are not answering',
          stillWorks:
            'Signed requests to existing triggers are still accepted; only this list is missing.',
        }}
        skeleton={<Skeleton className="h-48 w-full" />}
        empty={
          <EmptyState
            title="URLs that start work from outside"
            description="Create a trigger to let CI, a deploy hook or another system start a skill run or the next orchestrator round on a project. New trigger is at the top of the page."
          />
        }
      >
        {(list) => (
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
              {list.map((trigger) => (
                <TableRow key={trigger.id}>
                  <TableCell>
                    <span className="font-medium">{trigger.name}</span>
                  </TableCell>
                  <TableCell>
                    {projectLabel(trigger.projectId, projectList)}
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
                    {!trigger.enabled && trigger.disabledReason ? (
                      <div className="text-xs text-ink-3">
                        {deliveryReasonLabel(trigger.disabledReason)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {trigger.lastDelivery ? (
                      <div className="flex items-center gap-2">
                        <Badge
                          tone={
                            INBOUND_STATUS_TONE[trigger.lastDelivery.status]
                          }
                          label={
                            INBOUND_STATUS_LABEL[trigger.lastDelivery.status]
                          }
                        />
                        <span className="text-xs text-ink-3">
                          <Time value={trigger.lastDelivery.receivedAt} />
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
      </AsyncSection>

      <TriggerDialog
        open={editing !== undefined}
        trigger={editing === 'new' ? undefined : editing}
        projects={projects}
        onClose={() => setEditing(undefined)}
        onCreated={(created) => {
          setEditing(undefined);
          setRevealed(revealTrigger('Trigger created', created));
          reload();
        }}
        onSaved={() => {
          setEditing(undefined);
          toast.success('Trigger saved');
          reload();
        }}
      />

      <TriggerSheet
        triggerId={selected}
        projectName={
          selectedTrigger
            ? projectLabel(selectedTrigger.projectId, projectList)
            : ''
        }
        onClose={() => setSelected(undefined)}
        onEdit={setEditing}
        onRotated={(rotated) =>
          setRevealed(revealTrigger('Secret rotated', rotated))
        }
        onChanged={reload}
      />

      <SecretDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </div>
  );
}
