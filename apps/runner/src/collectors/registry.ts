import type {
  GitHubAppHealth,
  UnsequencedEvent,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { type Clock, systemClock } from '../clock';
import type { Exec } from '../detect/exec';
import { errorMessage, type Logger } from '../log';

export type { WatchedProject };

/** Hands an event to the connection, which spools and sends it. */
export type Emit = (event: UnsequencedEvent) => void;

/** Fleet polling intervals (spec 11 Configuration). */
export interface FleetSettings {
  pollSeconds: number;
  prPollSeconds: number;
  /** `events.jsonl` poll fallback (spec 16 D2); default 5. */
  eventsPollSeconds?: number;
  /** `issues` collector poll (spec 19, `queue.pollSeconds`); default 60. */
  queuePollSeconds?: number;
}

export const DEFAULT_FLEET_SETTINGS: FleetSettings = {
  pollSeconds: 15,
  prPollSeconds: 60,
  eventsPollSeconds: 5,
};

/** What the daemon hands every collector it creates. */
export interface CollectorContext {
  /** Fixed-argv runner for local tools (`tmux`, `git`, `gh`) — never a shell. */
  exec: Exec;
  clock: Clock;
  log: Logger;
  fleet: FleetSettings;
}

/**
 * Something that watches one project and emits events (D16). One instance is
 * created per project; `stop` releases whatever `start` acquired.
 */
export interface Collector {
  readonly name: string;
  start(project: WatchedProject, emit: Emit): void | Promise<void>;
  stop(): void | Promise<void>;
  /**
   * Spec 27 D12: the project's GitHub App health is known at creation and
   * whenever it changes. Absent means `unhealthy`. Only collectors that back
   * off while the App is healthy implement it.
   */
  setGithubApp?(health: GitHubAppHealth | undefined): void;
  /**
   * Spec 27 D13: poll now, without restarting. Takes the pollable names
   * (`issues`, `prs`, `worktrees`) and resolves with the ones this collector
   * polled.
   */
  pollNow?(targets: readonly string[]): Promise<string[]>;
}

/** Creates a fresh collector for one project. */
export type CollectorFactory = (context: CollectorContext) => Collector;

interface Running {
  project: WatchedProject;
  collectors: Collector[];
}

export interface CollectorRegistryOptions {
  factories: readonly CollectorFactory[];
  emit: Emit;
  log: Logger;
  /** Default: no local tools (every exec answers "not installed"), the system clock, default intervals. */
  context?: Partial<Omit<CollectorContext, 'log'>>;
}

const noTools: Exec = async () => null;

/**
 * Keeps one instance of every registered collector running per watched
 * project: started when a project joins the watch list, stopped when it
 * leaves, restarted when its root changes.
 */
export class CollectorRegistry {
  private readonly running = new Map<string, Running>();
  private queue: Promise<void> = Promise.resolve();
  private readonly context: CollectorContext;

  constructor(private readonly options: CollectorRegistryOptions) {
    this.context = {
      exec: options.context?.exec ?? noTools,
      clock: options.context?.clock ?? systemClock,
      fleet: options.context?.fleet ?? DEFAULT_FLEET_SETTINGS,
      log: options.log,
    };
  }

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

  /**
   * Polls the named collectors of one project now, leaving every other
   * collector alone; resolves with the names that were polled, in the order
   * asked. Waits for a start or stop in progress, but not for other polls.
   */
  async pollNow(
    projectId: string,
    targets: readonly string[],
  ): Promise<string[]> {
    await this.queue;
    const polled = new Set<string>();
    for (const collector of this.running.get(projectId)?.collectors ?? []) {
      if (!collector.pollNow) continue;
      try {
        for (const name of await collector.pollNow(targets)) polled.add(name);
      } catch (error) {
        this.options.log.error('collector: poll failed', {
          collector: collector.name,
          projectId,
          error: errorMessage(error),
        });
      }
    }
    return targets.filter((name) => polled.has(name));
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
      } else if (wanted.githubApp !== running.project.githubApp) {
        // Health alone never restarts a project's collectors (spec 27 D12).
        running.project = { ...running.project, githubApp: wanted.githubApp };
        for (const collector of running.collectors) {
          collector.setGithubApp?.(wanted.githubApp);
        }
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
      const collector = create(this.context);
      collector.setGithubApp?.(running.project.githubApp);
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
