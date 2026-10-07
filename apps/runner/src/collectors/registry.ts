import type {
  UnsequencedEvent,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { errorMessage, type Logger } from '../log';

export type { WatchedProject };

/** Hands an event to the connection, which spools and sends it. */
export type Emit = (event: UnsequencedEvent) => void;

/**
 * Something that watches one project and emits events (D16). One instance is
 * created per project; `stop` releases whatever `start` acquired.
 */
export interface Collector {
  readonly name: string;
  start(project: WatchedProject, emit: Emit): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** Creates a fresh collector for one project. */
export type CollectorFactory = () => Collector;

interface Running {
  project: WatchedProject;
  collectors: Collector[];
}

export interface CollectorRegistryOptions {
  factories: readonly CollectorFactory[];
  emit: Emit;
  log: Logger;
}

/**
 * Keeps one instance of every registered collector running per watched
 * project: started when a project joins the watch list, stopped when it
 * leaves, restarted when its root changes.
 */
export class CollectorRegistry {
  private readonly running = new Map<string, Running>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CollectorRegistryOptions) {}

  /** The projects collectors are running for, in watch-list order. */
  get projects(): WatchedProject[] {
    return [...this.running.values()].map((r) => r.project);
  }

  /**
   * Applies a new watch list; a project already running on the same root is
   * left alone. Calls are serialized, so a list arriving mid-apply waits.
   */
  setProjects(projects: readonly WatchedProject[]): Promise<void> {
    const work = this.queue.then(() => this.apply(projects));
    this.queue = work.catch(() => {});
    return work;
  }

  /** Stops every collector of every project. */
  stop(): Promise<void> {
    return this.setProjects([]);
  }

  private async apply(projects: readonly WatchedProject[]): Promise<void> {
    const next = new Map(projects.map((p) => [p.id, p]));
    for (const [id, running] of this.running) {
      const wanted = next.get(id);
      if (!wanted || wanted.root !== running.project.root) {
        this.running.delete(id);
        await this.stopAll(running);
      }
    }
    for (const project of next.values()) {
      if (this.running.has(project.id)) continue;
      const running: Running = { project: { ...project }, collectors: [] };
      this.running.set(project.id, running);
      await this.startAll(running);
    }
  }

  private async startAll(running: Running): Promise<void> {
    const { log, emit } = this.options;
    for (const create of this.options.factories) {
      const collector = create();
      try {
        await collector.start(running.project, emit);
        running.collectors.push(collector);
      } catch (error) {
        log.error('collector: start failed', {
          collector: collector.name,
          projectId: running.project.id,
          error: errorMessage(error),
        });
      }
    }
  }

  private async stopAll(running: Running): Promise<void> {
    for (const collector of running.collectors) {
      try {
        await collector.stop();
      } catch (error) {
        this.options.log.error('collector: stop failed', {
          collector: collector.name,
          projectId: running.project.id,
          error: errorMessage(error),
        });
      }
    }
  }
}
