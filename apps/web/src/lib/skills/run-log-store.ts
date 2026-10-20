import type {
  LiveErrorCode,
  LiveEventMessage,
  LiveTopic,
} from '@nautelle/shared';
import {
  RUN_LOG_LIVE_EVENTS,
  runLogFrameSchema,
} from '@nautelle/shared/protocol';
import type { LiveClient } from '../live/client';
import {
  applyRunLogFrame,
  beginReplay,
  EMPTY_RUN_LOG,
  type RunLogState,
} from './run-log';

const ERROR_SENTENCE: Partial<Record<LiveErrorCode, string>> = {
  forbidden: 'You are not a member of this project, so you cannot watch it.',
  not_found: 'This run does not belong to this project.',
};

export interface RunLogView {
  log: RunLogState;
  /** When the newest live line arrived here (ms); null before any (#275 D4). */
  lastLineAt: number | null;
  connected: boolean;
  /** A sentence when the server refused the topic. */
  error: string | undefined;
}

export const EMPTY_RUN_LOG_VIEW: RunLogView = {
  log: EMPTY_RUN_LOG,
  lastLineAt: null,
  connected: false,
  error: undefined,
};

/**
 * The lines of one run topic in this tab. The live client sends the server
 * `subscribe` (and so the backlog) only to the first subscriber of a topic, so
 * every reader of the same run shares one store: a reader that mounts late sees
 * the lines already received. Nothing outlives the last reader.
 */
class RunLogStore {
  private view: RunLogView;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly client: LiveClient,
    private readonly topic: LiveTopic,
  ) {
    this.view = {
      ...EMPTY_RUN_LOG_VIEW,
      connected: client.getSnapshot().status === 'connected',
    };
  }

  getView = (): RunLogView => this.view;

  /** Adds a reader; returns its release. The last release closes the topic. */
  attach(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.open();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.close();
    };
  }

  get readers(): number {
    return this.listeners.size;
  }

  private open() {
    this.unwatch = this.client.onChange(this.onStatus);
    this.unsubscribe = this.client.subscribe(
      this.topic,
      this.onMessage,
      this.onError,
    );
  }

  private close() {
    this.unsubscribe?.();
    this.unwatch?.();
    this.unsubscribe = null;
    this.unwatch = null;
  }

  private set(next: Partial<RunLogView>) {
    this.view = { ...this.view, ...next };
    for (const listener of this.listeners) listener();
  }

  private readonly onStatus = () => {
    const connected = this.client.getSnapshot().status === 'connected';
    if (connected === this.view.connected) return;
    // A reconnect makes the server replay the backlog: the next one replaces the lines.
    this.set({
      connected,
      log: connected ? this.view.log : beginReplay(this.view.log),
    });
  };

  private readonly onError = (code: LiveErrorCode) => {
    this.set({
      error: ERROR_SENTENCE[code] ?? 'The live log could not be opened.',
    });
  };

  private readonly onMessage = (message: LiveEventMessage) => {
    if (
      message.event !== RUN_LOG_LIVE_EVENTS.lines &&
      message.event !== RUN_LOG_LIVE_EVENTS.ended
    ) {
      return;
    }
    const parsed = runLogFrameSchema.safeParse(message.data);
    if (!parsed.success) return;
    const frame = parsed.data;
    const fresh =
      frame.type === 'lines' && !frame.backlog && frame.lines.length > 0;
    this.set({
      log: applyRunLogFrame(this.view.log, frame),
      lastLineAt: fresh ? Date.now() : this.view.lastLineAt,
    });
  };
}

/** The stores of one live client, one per run topic that has a reader. */
export class RunLogRegistry {
  private readonly stores = new Map<LiveTopic, RunLogStore>();

  constructor(private readonly client: LiveClient) {}

  /** For `useSyncExternalStore`: the store's current view, empty before a reader attached. */
  getView = (topic: LiveTopic): RunLogView =>
    this.stores.get(topic)?.getView() ?? EMPTY_RUN_LOG_VIEW;

  /** For `useSyncExternalStore`: attaches a reader to the topic's shared store. */
  attach(topic: LiveTopic, listener: () => void): () => void {
    let store = this.stores.get(topic);
    if (!store) {
      store = new RunLogStore(this.client, topic);
      this.stores.set(topic, store);
    }
    const owned = store;
    const release = owned.attach(listener);
    return () => {
      release();
      if (owned.readers === 0 && this.stores.get(topic) === owned) {
        this.stores.delete(topic);
      }
    };
  }
}
