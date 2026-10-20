import { describe, expect, test } from 'bun:test';
import type { WhatsNewView } from '@nautelle/shared';
import { createWhatsNewStore } from './whats-new-store';

const view = (unread: boolean): WhatsNewView => ({
  version: '0.14.0',
  seenVersion: unread ? null : '0.14.0',
  unread,
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('the What’s new unread dot (C-294)', () => {
  test('shows what the server says, and clears once viewed', async () => {
    let marked = 0;
    const store = createWhatsNewStore({
      fetch: async () => view(true),
      mark: async () => {
        marked++;
        return view(false);
      },
    });
    let changes = 0;
    store.subscribe(() => changes++);
    expect(store.unread()).toBe(false);

    await store.load();
    expect(store.unread()).toBe(true);

    await store.markSeen();
    expect(store.unread()).toBe(false);
    expect(marked).toBe(1);
    expect(changes).toBe(2);
  });

  test('a read that answers after the page was opened brings no dot back', async () => {
    const answer = deferred<WhatsNewView>();
    const store = createWhatsNewStore({
      fetch: () => answer.promise,
      mark: async () => view(false),
    });
    const loading = store.load();
    await store.markSeen();
    answer.resolve(view(true));
    await loading;
    expect(store.unread()).toBe(false);
  });

  test('no dot when the server cannot be read, and none for a seen version', async () => {
    const failing = createWhatsNewStore({
      fetch: async () => {
        throw new Error('offline');
      },
      mark: async () => view(false),
    });
    await failing.load();
    expect(failing.unread()).toBe(false);

    const seen = createWhatsNewStore({
      fetch: async () => view(false),
      mark: async () => view(false),
    });
    await seen.load();
    expect(seen.unread()).toBe(false);
  });

  test('a failed mark still clears the dot here', async () => {
    const store = createWhatsNewStore({
      fetch: async () => view(true),
      mark: async () => {
        throw new Error('offline');
      },
    });
    await store.load();
    await store.markSeen();
    expect(store.unread()).toBe(false);
  });
});
