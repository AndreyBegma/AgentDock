import { type FSWatcher, watch } from 'node:fs';
import {
  EVENT_SCHEMA_VERSION,
  isSessionEventType,
  type Runtime,
  SESSION_OBSERVED_EVENT,
  type SessionBackfillResult,
  type SessionObservedData,
  sessionEventDataSchemas,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { Cancel, Clock } from '../clock';
import type { ConfigProfile } from '../config';
import { errorMessage, type Logger } from '../log';
import { OffsetStore } from './offsets';
import {
  type FileState,
  freshState,
  type RuntimeAdapter,
  type TranscriptSource,
} from './types';

/** D2: a new transcript is picked up within this even when `fs.watch` misses it. */
export const RESCAN_INTERVAL_MS = 30_000;
/** A burst of writes is read once. */
const DEBOUNCE_MS = 1_000;
/** Offsets are written at most this often while a scan reads many files. */
const SAVE_INTERVAL_MS = 1_000;

export interface SessionWatcherOptions {
  adapters: Readonly<Record<Runtime, RuntimeAdapter>>;
  profiles: readonly ConfigProfile[];
  home: string;
  offsetsFile: string;
  /** Transcripts last modified before it are read only by a backfill (D11). */
  ingestSince: Date;
  emit: (event: UnsequencedEvent) => void;
  clock: Clock;
  log: Logger;
  /** `fs.watch` the profile directories. Tests drive `scan()` themselves. */
  watch?: boolean;
}

export interface BackfillScope {
  projectId?: string;
  since: Date;
}

/**
 * Turns every runtime profile's transcripts into session events (spec 12).
 * One per daemon, not per project: a profile holds the sessions of every
 * directory on the machine, and those outside any project are reported too,
 * for admins (D10). Reads are serialized, so a scan, a watch-list change and
 * a backfill never read the same file at once.
 */
export class SessionWatcher {
  private store: OffsetStore | null = null;
  private projects: readonly WatchedProject[] = [];
  /** The last discovery, by path: what a re-correlation needs to re-send. */
  private sources = new Map<string, TranscriptSource>();
  private queue: Promise<unknown> = Promise.resolve();
  private watchers: FSWatcher[] = [];
  private cancels: Cancel[] = [];
  private pending: Cancel | null = null;
  private lastSave = 0;
  private dirty = false;
  private stopped = false;

  constructor(private readonly options: SessionWatcherOptions) {}

  /** Loads the offsets, reads what is new, then follows the profiles. */
  async start(projects: readonly WatchedProject[]): Promise<void> {
    const { log, clock } = this.options;
    this.store = OffsetStore.load(this.options.offsetsFile, log);
    this.projects = projects;
    if (this.options.watch !== false) {
      for (const root of this.roots()) {
        try {
          const watcher = watch(root, { recursive: true }, () =>
            this.schedule(),
          );
          watcher.on('error', (error) => {
            log.warn('sessions: watch failed, rescans continue', {
              root,
              error: errorMessage(error),
            });
          });
          this.watchers.push(watcher);
        } catch {
          // No such directory yet: the periodic rescan covers it.
        }
      }
      this.cancels.push(
        clock.setInterval(() => this.schedule(), RESCAN_INTERVAL_MS),
      );
    }
    await this.scan();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
    this.pending?.();
    this.pending = null;
    await this.queue;
    this.save(true);
  }

  /** Reads every transcript that grew since its offset. */
  scan(): Promise<void> {
    return this.enqueue(() => this.readNew());
  }

  /** The watch list changed: re-sends `session.observed` whose correlation moved (D6). */
  setProjects(projects: readonly WatchedProject[]): Promise<void> {
    return this.enqueue(async () => {
      this.projects = projects;
      this.recorrelate();
    });
  }

  /**
   * Re-reads from the start every transcript modified after `since` (D11),
   * ignoring `ingestSince`. With `projectId`, only sessions correlated to it
   * are sent. Offsets end at each file's end, so tailing goes on from there.
   */
  backfill(scope: BackfillScope): Promise<SessionBackfillResult> {
    return this.enqueue(() => this.readAll(scope));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch((error) => {
      this.options.log.error('sessions: read failed', {
        error: errorMessage(error),
      });
    });
    return next;
  }

  private schedule(): void {
    if (this.stopped || this.pending) return;
    this.pending = this.options.clock.setTimeout(() => {
      this.pending = null;
      this.scan().catch(() => {});
    }, DEBOUNCE_MS);
  }

  private roots(): string[] {
    const { profiles, adapters, home } = this.options;
    return [
      ...new Set(profiles.flatMap((p) => adapters[p.runtime].roots(p, home))),
    ];
  }

  /** Every transcript of every profile; a file two profiles share is read once. */
  private discover(): TranscriptSource[] {
    const { profiles, adapters, home } = this.options;
    const found = new Map<string, TranscriptSource>();
    for (const profile of profiles) {
      for (const source of adapters[profile.runtime].discover(profile, home)) {
        if (!found.has(source.path)) found.set(source.path, source);
      }
    }
    this.sources = found;
    return [...found.values()];
  }

  private requireStore(): OffsetStore {
    if (!this.store) throw new Error('SessionWatcher used before start()');
    return this.store;
  }

  private async readNew(): Promise<void> {
    const store = this.requireStore();
    const since = this.options.ingestSince.getTime();
    const sources = this.discover();
    for (const source of sources) {
      if (this.stopped) break;
      let state = store.get(source.path);
      if (!state) {
        if (source.mtimeMs < since) continue;
        state = freshState();
      }
      // Smaller than what was read: replaced or truncated, read it anew.
      if (source.size < state.offset) state = freshState();
      if (source.size === state.offset && state.observed) continue;
      await this.read(source, state);
    }
    for (const [path] of store.entries()) {
      if (!this.sources.has(path)) {
        store.delete(path);
        this.dirty = true;
      }
    }
    this.save(true);
  }

  private async readAll(scope: BackfillScope): Promise<SessionBackfillResult> {
    const store = this.requireStore();
    const since = scope.since.getTime();
    let files = 0;
    let events = 0;
    for (const source of this.discover()) {
      if (source.mtimeMs <= since) continue;
      const adapter = this.options.adapters[source.runtime];
      // Without a project, every session counts; with one, a file is
      // decided by its `session.observed`, and what precedes it waits.
      let wanted: boolean | null = scope.projectId ? null : true;
      const held: UnsequencedEvent[] = [];
      for await (const chunk of adapter.tail(source, freshState(), {
        projects: this.projects,
      })) {
        if (wanted === null && chunk.state.observed) {
          wanted = chunk.state.observed.projectId === scope.projectId;
        }
        if (wanted === false) break;
        if (wanted === null) {
          held.push(...chunk.events);
          continue;
        }
        events += this.send(held.splice(0).concat(chunk.events));
        store.set(source.path, chunk.state);
        this.dirty = true;
        this.save(false);
      }
      if (wanted) files += 1;
    }
    this.save(true);
    return { files, events };
  }

  private async read(source: TranscriptSource, state: FileState) {
    const adapter = this.options.adapters[source.runtime];
    for await (const chunk of adapter.tail(source, state, {
      projects: this.projects,
    })) {
      this.send(chunk.events);
      // Saved after the events are spooled: a crash in between re-sends,
      // which the API deduplicates, and never loses (D5).
      this.requireStore().set(source.path, chunk.state);
      this.dirty = true;
      this.save(false);
    }
  }

  private recorrelate(): void {
    const store = this.requireStore();
    const now = new Date(this.options.clock.now()).toISOString();
    for (const [path, state] of store.entries()) {
      const source = this.sources.get(path);
      if (!source || !state.observed) continue;
      const { projectId, slot } = this.options.adapters[
        source.runtime
      ].correlate({ cwd: state.observed.cwd }, this.projects);
      if (
        projectId === state.observed.projectId &&
        slot === state.observed.slot
      ) {
        continue;
      }
      const { projectId: _project, slot: _slot, ...rest } = state.observed;
      const observed: SessionObservedData = {
        ...rest,
        ...(projectId ? { projectId } : {}),
        ...(slot ? { slot } : {}),
      };
      this.send([
        {
          v: EVENT_SCHEMA_VERSION,
          ts: now,
          type: SESSION_OBSERVED_EVENT,
          source: 'transcript',
          session: { runtime: source.runtime, id: source.sessionId },
          data: observed,
        },
      ]);
      store.set(path, { ...state, observed });
      this.dirty = true;
    }
    this.save(true);
  }

  /**
   * Emits the events whose `data` passes the shared schema, with every field
   * outside it dropped (D9). Returns how many were emitted.
   */
  private send(events: readonly UnsequencedEvent[]): number {
    let sent = 0;
    for (const event of events) {
      if (!isSessionEventType(event.type)) continue;
      const data = sessionEventDataSchemas[event.type].safeParse(event.data);
      if (!data.success) {
        this.options.log.warn('sessions: dropped an invalid event', {
          type: event.type,
          session: event.session?.id,
        });
        continue;
      }
      this.options.emit({ ...event, data: data.data });
      sent += 1;
    }
    return sent;
  }

  private save(force: boolean): void {
    if (!this.dirty || !this.store) return;
    const now = this.options.clock.now();
    if (!force && now - this.lastSave < SAVE_INTERVAL_MS) return;
    try {
      this.store.save();
      this.dirty = false;
      this.lastSave = now;
    } catch (error) {
      this.options.log.error('sessions: cannot write offsets', {
        error: errorMessage(error),
      });
    }
  }
}
