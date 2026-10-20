import type { WhatsNewView } from '@nautelle/shared';
import { fetchWhatsNew, markWhatsNewSeen } from './whats-new';

/** C-294: the shell's unread dot, framework-free so it is testable on its own. */
export interface WhatsNewStore {
  unread: () => boolean;
  subscribe: (listener: () => void) => () => void;
  /** Reads the server's state; on any error there is no dot. */
  load: () => Promise<void>;
  /** What's new was opened: no dot from now on, here and on the server. */
  markSeen: () => Promise<void>;
}

interface WhatsNewApi {
  fetch: () => Promise<WhatsNewView>;
  mark: () => Promise<WhatsNewView>;
}

export function createWhatsNewStore(
  http: WhatsNewApi = { fetch: fetchWhatsNew, mark: markWhatsNewSeen },
): WhatsNewStore {
  let unread = false;
  // Opened before the first read answered: that answer is already stale.
  let seen = false;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    if (next === unread) return;
    unread = next;
    for (const listener of listeners) listener();
  };

  return {
    unread: () => unread,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: async () => {
      try {
        const view = await http.fetch();
        set(view.unread && !seen);
      } catch {
        set(false);
      }
    },
    markSeen: async () => {
      seen = true;
      set(false);
      try {
        await http.mark();
      } catch {
        // The dot comes back on the next load; nothing to tell the person.
      }
    },
  };
}
