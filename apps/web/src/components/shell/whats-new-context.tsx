'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  createWhatsNewStore,
  type WhatsNewStore,
} from '../../lib/whats-new/whats-new-store';

interface WhatsNew {
  /** The person has not opened What's new on this version yet. */
  unread: boolean;
  /** What's new was opened: clears the dot here and on the server. */
  markSeen: () => void;
}

const WhatsNewContext = createContext<WhatsNewStore | null>(null);

const noDot = () => false;
const noSubscribe = () => () => {};

/** C-294: the account menu's unread dot, read once per shell. */
export function WhatsNewProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createWhatsNewStore);
  useEffect(() => {
    void store.load();
  }, [store]);
  return (
    <WhatsNewContext.Provider value={store}>
      {children}
    </WhatsNewContext.Provider>
  );
}

export function useWhatsNew(): WhatsNew {
  const store = useContext(WhatsNewContext);
  const unread = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.unread ?? noDot,
    noDot,
  );
  // Stable across the dot changing, so a page may call it from an effect.
  const markSeen = useCallback(() => void store?.markSeen(), [store]);
  return useMemo(() => ({ unread, markSeen }), [unread, markSeen]);
}
