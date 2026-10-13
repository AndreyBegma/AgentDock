'use client';

import type {
  GitHubAppView,
  InboundTriggerView,
  TelegramIntegrationStatus,
  WebhookView,
} from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { buttonClassName } from 'glass-ui/button';
import { Card } from 'glass-ui/card';
import { Skeleton } from 'glass-ui/skeleton';
import Link from 'next/link';
import { api } from '../../../lib/api';
import {
  gitHubAppStatus,
  type IntegrationStatus,
  telegramStatus,
  triggersStatus,
  UNAVAILABLE,
  webhooksStatus,
} from '../../../lib/integrations/format';
import { type Section, useSection } from '../../../lib/section/use-section';

/** The card's status: loading, unknown after a failure, or derived from the data. */
function statusOf<T>(
  section: Section<T>,
  derive: (data: T) => IntegrationStatus,
): IntegrationStatus | undefined {
  if (section.data !== undefined) return derive(section.data);
  return section.error !== null && !section.loading ? UNAVAILABLE : undefined;
}

function IntegrationCard({
  title,
  purpose,
  href,
  status,
}: {
  title: string;
  purpose: string;
  href: string;
  status: IntegrationStatus | undefined;
}) {
  return (
    <Card pad="lg" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        {status ? (
          <Badge tone={status.tone} label={status.label} />
        ) : (
          <Skeleton className="h-6 w-28" />
        )}
      </div>
      <p className="text-sm text-ink-2">{purpose}</p>
      {status ? <p className="text-sm text-ink-3">{status.detail}</p> : null}
      <div className="mt-auto">
        <Link
          href={href}
          className={buttonClassName({ variant: 'glass', size: 'sm' })}
        >
          Open {title}
        </Link>
      </div>
    </Card>
  );
}

export default function IntegrationsPage() {
  const github = useSection(() => api<GitHubAppView>('/admin/github-app'), []);
  const telegram = useSection(
    () => api<TelegramIntegrationStatus>('/admin/integrations/telegram'),
    [],
  );
  const webhooks = useSection(() => api<WebhookView[]>('/admin/webhooks'), []);
  const triggers = useSection(
    () => api<InboundTriggerView[]>('/admin/triggers'),
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="max-w-prose text-sm text-ink-2">
          How AgentDock talks to the outside world. None is required; each one
          adds a way in or out.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <IntegrationCard
          title="GitHub App"
          purpose="Tells AgentDock the moment an issue, pull request or check changes."
          href="/admin/integrations/github"
          status={statusOf(github, gitHubAppStatus)}
        />
        <IntegrationCard
          title="Telegram"
          purpose="Notifications and approvals in each person’s own Telegram chat."
          href="/admin/integrations/telegram"
          status={statusOf(telegram, telegramStatus)}
        />
        <IntegrationCard
          title="Webhooks"
          purpose="Outbound: AgentDock’s events pushed to a URL you choose."
          href="/admin/integrations/webhooks"
          status={statusOf(webhooks, webhooksStatus)}
        />
        <IntegrationCard
          title="Triggers"
          purpose="Inbound: a signed request from outside starts work on a project."
          href="/admin/integrations/triggers"
          status={statusOf(triggers, triggersStatus)}
        />
      </div>
    </div>
  );
}
