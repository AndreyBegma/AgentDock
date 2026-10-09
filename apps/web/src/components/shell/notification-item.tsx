'use client';

import type { NotificationView } from '@agentdock/shared';
import { Badge } from 'glass-ui/badge';
import { Button } from 'glass-ui/button';
import { Check } from 'lucide-react';
import Link from 'next/link';
import {
  isUnread,
  KIND_LABEL,
  KIND_TONE,
  relativeTime,
  safeLink,
} from '../../lib/notifications/format';

/** One notification: kind, title, project and time, with its read control. */
export function NotificationItem({
  item,
  onRead,
  onNavigate,
}: {
  item: NotificationView;
  onRead: (id: string) => void;
  /** Called when the title link is followed (the bell closes its panel). */
  onNavigate?: () => void;
}) {
  const unread = isUnread(item);
  const link = safeLink(item.link);
  const title = (
    <span className={unread ? 'font-semibold' : 'text-ink-2'}>
      {item.title}
    </span>
  );

  return (
    <li
      className="flex items-start gap-3 px-4 py-3"
      data-unread={unread ? 'true' : 'false'}
    >
      <Badge
        dot
        tone={unread ? KIND_TONE[item.kind] : 'neutral'}
        className="mt-1.5 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-sm">
        {link ? (
          <Link href={link} onClick={onNavigate} className="hover:underline">
            {title}
          </Link>
        ) : (
          title
        )}
        <p className="text-ink-2 break-words">{item.body}</p>
        <p className="text-ink-3 text-xs">
          {KIND_LABEL[item.kind]}
          {item.projectName ? ` · ${item.projectName}` : ''}
          {item.count > 1 ? ` · ×${item.count}` : ''}
          {item.muted ? ' · muted' : ''} · {relativeTime(item.lastAt)}
        </p>
      </div>
      {item.readAt === null && !item.muted ? (
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label={`Mark "${item.title}" as read`}
          onClick={() => onRead(item.id)}
        >
          <Check size={14} aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}
