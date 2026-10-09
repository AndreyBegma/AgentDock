import { type FSWatcher, readFileSync, statSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  eventsUnparsedData,
  normalizeCodeSentinelLine,
} from '@agentdock/shared';
import {
  codeSentinelStateSchema,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { OffsetStore } from '../../adapters/offsets';
import type { Cancel } from '../../clock';
import { resolvePaths } from '../../env';
import {
  type FleetEmitter,
  type FleetProject,
  fleetEmitter,
  resolveFleetProject,
} from '../../fleet/project';
import { errorMessage } from '../../log';
import type {
  Collector,
  CollectorContext,
  CollectorFactory,
  Emit,
  WatchedProject,
} from '../registry';
import { readNewLines, type TailState } from './tail';

export const EVENTS_FILE = 'events.jsonl';
export const STATE_FILE = 'state.json';
/** Offsets live beside spec 12's `offsets.json`, in a file of their own (spec 16 D2). */
export const EVENTS_OFFSETS_FILE = 'events-offsets.json';
/** A burst of `fs.watch` notices is read once, this long after the first. */
export const EVENTS_DEBOUNCE_MS = 200;
const DEFAULT_POLL_SECONDS = 5;

export interface EventsCollectorOptions {
  /** Default: `events-offsets.json` in the runner's state directory. */
  offsetsFile?: string;
  /** `fs.watch` the board directory; the poll runs regardless. */
  watchFiles?: boolean;
}

/** One store per file per process: two stores over a file would overwrite each other. */
const stores = new Map<string, OffsetStore>();

const storeFor = (path: string, context: CollectorContext): OffsetStore => {
  let store = stores.get(path);
  if (!store) {
    store = OffsetStore.load(path, context.log);
    stores.set(path, store);
  }
  return store;
};

/** Drops the in-memory stores, so the next collector reads the file — a runner restart, in tests. */
export const forgetOffsetStores = (): void => stores.clear();

const defaultOffsetsFile = (): string =>
  join(dirname(resolvePaths(process.env).offsetsFile), EVENTS_OFFSETS_FILE);

const inodeOf = (parser: unknown): number | undefined => {
  const inode = (parser as { inode?: unknown } | null)?.inode;
  return typeof inode === 'number' ? inode : undefined;
};

/**
 * Code Sentinel's machine-readable channel (spec 16): tails
 * `<git-common-dir>/cs-orchestrator/events.jsonl` and snapshots `state.json`.
 * A project whose plugin writes neither file emits nothing and keeps running on
 * the markdown collectors. Every step is guarded; a bad line never stops the
 * tail.
 */
export class EventsCollector implements Collector {
  readonly name = 'events';
  private project: FleetProject | null = null;
  private emitFleet: FleetEmitter | null = null;
  private emitRaw: Emit | null = null;
  private store: OffsetStore | null = null;
  private timers: Cancel[] = [];
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private debounce: Cancel | null = null;
  private running = false;
  private again = false;
  private stopped = false;
  private lastState: string | null = null;
  private first: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: CollectorContext,
    private readonly options: EventsCollectorOptions = {},
  ) {}

  async start(watched: WatchedProject, emit: Emit): Promise<void> {
    const { exec, clock, fleet } = this.context;
    const project = await resolveFleetProject(exec, watched);
    this.project = project;
    this.emitRaw = emit;
    this.emitFleet = fleetEmitter(project, clock, emit);
    this.store = storeFor(
      this.options.offsetsFile ?? defaultOffsetsFile(),
      this.context,
    );
    this.first = this.pass();
    this.timers.push(
      clock.setInterval(
        () => void this.pass(),
        (fleet.eventsPollSeconds ?? DEFAULT_POLL_SECONDS) * 1000,
      ),
    );
  }

  /** Resolves once the first pass after `start` has run. */
  settled(): Promise<void> {
    return this.first;
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.timers) cancel();
    this.timers = [];
    this.debounce?.();
    this.watcher?.close();
    this.watcher = null;
  }

  /** One read of `events.jsonl` and `state.json`; passes never overlap and never throw. */
  async pass(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        this.armWatcher();
        this.readState();
        this.readEvents();
      } while (this.again && !this.stopped);
    } catch (error) {
      this.context.log.warn('events: pass failed', {
        projectId: this.project?.id,
        error: errorMessage(error),
      });
    } finally {
      this.running = false;
    }
  }

  private key(project: FleetProject): string {
    return `events:${project.id}`;
  }

  private readEvents(): void {
    const project = this.project;
    const emitFleet = this.emitFleet;
    const emitRaw = this.emitRaw;
    const store = this.store;
    if (!project || !emitFleet || !emitRaw || !store) return;
    const file = join(project.boardDir, EVENTS_FILE);
    for (;;) {
      const saved = store.get(this.key(project));
      const previous: TailState | undefined =
        saved && inodeOf(saved.parser) !== undefined
          ? { offset: saved.offset, inode: inodeOf(saved.parser) as number }
          : undefined;
      const read = readNewLines(file, previous);
      if (!read) return;
      for (const line of read.lines) {
        const result = normalizeCodeSentinelLine(line.text, {
          repo: project.repo,
          root: project.root,
        });
        if (result.ok) {
          emitRaw(result.event);
        } else {
          emitFleet(
            'events.unparsed',
            eventsUnparsedData(file, line.text, result.reason, line.offset),
          );
        }
      }
      // After the emits: a crash in between re-reads, which the API dedupes.
      store.set(this.key(project), {
        offset: read.state.offset,
        observed: null,
        parser: { inode: read.state.inode },
      });
      this.save();
      if (!read.more) return;
    }
  }

  private readState(): void {
    const project = this.project;
    const emitFleet = this.emitFleet;
    const emitRaw = this.emitRaw;
    if (!project || !emitFleet || !emitRaw) return;
    const file = join(project.boardDir, STATE_FILE);
    let content: string;
    try {
      if (!statSync(file).isFile()) return;
      content = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (content === this.lastState) return;
    this.lastState = content;

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      emitFleet(
        'events.unparsed',
        eventsUnparsedData(file, content, 'malformed JSON'),
      );
      return;
    }
    const state = codeSentinelStateSchema.safeParse(raw);
    if (!state.success) {
      const issue = state.error.issues[0];
      emitFleet(
        'events.unparsed',
        eventsUnparsedData(
          file,
          content,
          `state.json: ${issue?.path.join('.') || 'root'}: ${issue?.message ?? 'invalid'}`,
        ),
      );
      return;
    }
    const event: UnsequencedEvent = {
      v: 1,
      ts:
        state.data.updatedAt ??
        new Date(this.context.clock.now()).toISOString(),
      type: 'orchestrator.snapshot',
      source: 'code-sentinel',
      project: { repo: project.repo, root: project.root },
      data: { state: state.data },
    };
    emitRaw(event);
  }

  private save(): void {
    try {
      this.store?.save();
    } catch (error) {
      this.context.log.error('events: cannot write offsets', {
        error: errorMessage(error),
      });
    }
  }

  /** Watches the board directory for appends; it may not exist yet, the poll covers that. */
  private armWatcher(): void {
    const project = this.project;
    if (!project || this.stopped || this.options.watchFiles === false) return;
    if (this.watcher && this.watchedDir === project.boardDir) return;
    this.watcher?.close();
    this.watcher = null;
    try {
      const watcher = watch(project.boardDir, { persistent: false }, () =>
        this.schedule(),
      );
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
      this.watchedDir = project.boardDir;
    } catch {
      // Not there yet: the poll arms it once the plugin creates the directory.
    }
  }

  private schedule(): void {
    if (this.debounce || this.stopped) return;
    this.debounce = this.context.clock.setTimeout(() => {
      this.debounce = null;
      void this.pass();
    }, EVENTS_DEBOUNCE_MS);
  }
}

export const eventsCollector =
  (options: EventsCollectorOptions = {}): CollectorFactory =>
  (context) =>
    new EventsCollector(context, options);
