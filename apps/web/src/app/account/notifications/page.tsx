'use client';

import { PageHeader } from '../../../components/page-header/page-header';
import { useTelegramLink } from '../../../lib/notifications/use-telegram-link';
import { FeedSection } from './feed-section';
import { MutesSection } from './mutes-section';
import { RulesSection } from './rules-section';
import { TelegramCard } from './telegram-card';

export default function NotificationsPage() {
  const link = useTelegramLink();
  const linked = link.view.status === 'ready' && link.view.state.linked;
  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Things that need a person, where to get them, and which projects to silence."
      />
      <div className="flex flex-col gap-6">
        <FeedSection />
        <TelegramCard link={link} />
        <RulesSection telegramLinked={linked} />
        <MutesSection />
      </div>
    </div>
  );
}
