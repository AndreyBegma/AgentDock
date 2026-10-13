'use client';

import type {
  GitHubAppView,
  InboundTriggerView,
  TelegramIntegrationStatus,
  WebhookView,
} from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { GitBranch, type LucideIcon, Send, Webhook, Zap } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '../../../components/page-header/page-header';
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
  icon: Icon,
}: {
  title: string;
  purpose: string;
  href: string;
  status: IntegrationStatus | undefined;
  icon: LucideIcon;
}) {
  return (
    <Card pad="lg" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-control border border-line bg-raised text-ink-2"
        >
          <Icon className="size-5" />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {title}
        </h2>
        {status ? (
          <Badge tone={status.tone} label={status.label} />
        ) : (
          <Skeleton className="h-6 w-28" />
        )}
      </div>
      <p className="text-sm text-ink-2">{purpose}</p>
      {status ? <p className="text-sm text-ink-3">{status.detail}</p> : null}
      <div className="mt-auto pt-1">
        <Link
          href={href}
          className={buttonClassName({ variant: 'solid', size: 'sm' })}
        >
          {status && notSetUp(status) ? `Set up ${title}` : `Manage ${title}`}
        </Link>
      </div>
    </Card>
  );
}

/** A card with nothing configured yet offers setup, otherwise management. */
const notSetUp = (status: IntegrationStatus): boolean =>
  status.label === 'Not set up' || status.label === 'None';

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
    <div className="flex flex-col gap-2">
      <PageHeader
        title="Integrations"
        description="How AgentDock talks to the outside world. None is required; each one adds a way in or out."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <IntegrationCard
          icon={GitBranch}
          title="GitHub App"
          purpose="Tells AgentDock the moment an issue, pull request or check changes."
          href="/admin/integrations/github"
          status={statusOf(github, gitHubAppStatus)}
        />
        <IntegrationCard
          icon={Send}
          title="Telegram"
          purpose="Notifications and approvals in each person’s own Telegram chat."
          href="/admin/integrations/telegram"
          status={statusOf(telegram, telegramStatus)}
        />
        <IntegrationCard
          icon={Webhook}
          title="Webhooks"
          purpose="Outbound: AgentDock’s events pushed to a URL you choose."
          href="/admin/integrations/webhooks"
          status={statusOf(webhooks, webhooksStatus)}
        />
        <IntegrationCard
          icon={Zap}
          title="Triggers"
          purpose="Inbound: a signed request from outside starts work on a project."
          href="/admin/integrations/triggers"
          status={statusOf(triggers, triggersStatus)}
        />
      </div>
    </div>
  );
}
