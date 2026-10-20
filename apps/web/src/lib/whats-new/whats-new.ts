import type { ChangeKind, WhatsNewView } from '@nautelle/shared';
import { api } from '../api';

/** C-294: the version and the unread dot, per person and stored server-side. */
export const WHATS_NEW_API = '/me/whats-new';

export const WHATS_NEW_HREF = '/whats-new';

export const fetchWhatsNew = () => api<WhatsNewView>(WHATS_NEW_API);

export const markWhatsNewSeen = () =>
  api<WhatsNewView>(`${WHATS_NEW_API}/seen`, { method: 'POST' });

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
};

export const CHANGE_KIND_TONE: Record<ChangeKind, 'ok' | 'neutral' | 'warn'> = {
  new: 'ok',
  improved: 'neutral',
  fixed: 'warn',
};

/** The tag a version is released under, as a person reads it. */
export const versionLabel = (version: string) => `v${version}`;

/** The avatar's name, which carries the dot for a screen reader. */
export const accountMenuLabel = (unread: boolean) =>
  unread ? 'Account menu, what’s new unread' : 'Account menu';

/** `2026-10-20` → `20 October 2026`, read as a calendar day in any zone. */
export const releaseDateLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
