'use client';

import { useTelegramLink } from '../../../lib/notifications/use-telegram-link';
import { FeedSection } from './feed-section';
import { MutesSection } from './mutes-section';
import { RulesSection } from './rules-section';
import { TelegramCard } from './telegram-card';

export default function NotificationsPage() {
  const link = useTelegramLink();
  const linked = link.view.status === 'ready' && link.view.state.linked;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-ink-2">
          Things that need a person, where to get them, and which projects to
          silence.
        </p>
      </div>
      <FeedSection />
      <TelegramCard link={link} />
      <RulesSection telegramLinked={linked} />
      <MutesSection />
    </div>
  );
}
