import type { WatchedProject } from '@agentdock/shared/protocol';
import type { CollectorRegistry } from '../collectors';
import { errorMessage, type Logger } from '../log';

export interface WatchListOptions {
  /** The cached list from the runner config, used until the server speaks. */
  initial: readonly WatchedProject[];
  registry: CollectorRegistry;
  /** Writes the list to the runner config as the next boot's cache. */
  persist: (projects: WatchedProject[]) => void;
  log: Logger;
}

const same = (a: readonly WatchedProject[], b: readonly WatchedProject[]) =>
  a.length === b.length &&
  a.every((p, i) => p.id === b[i].id && p.root === b[i].root);

/**
 * The projects this runner watches (D9). The server's list — `welcome` on
 * every connect, `config` after — is authoritative; the config file only
 * caches it so collectors run before the first connect.
 */
export class WatchList {
  private projects: WatchedProject[];

  constructor(private readonly options: WatchListOptions) {
    this.projects = options.initial.map((p) => ({ ...p }));
  }

  get current(): readonly WatchedProject[] {
    return this.projects;
  }

  /** Starts collectors for the cached list. */
  start(): Promise<void> {
    return this.options.registry.setProjects(this.projects);
  }

  /** Applies the server's list: collectors follow it, the cache is rewritten when it changed. */
  async apply(projects: readonly WatchedProject[]): Promise<void> {
    const next = projects.map((p) => ({ id: p.id, root: p.root }));
    const changed = !same(this.projects, next);
    this.projects = next;
    if (changed) {
      this.options.log.info('watch list changed', { projects: next.length });
      try {
        this.options.persist(next);
      } catch (error) {
        this.options.log.warn('cannot cache the watch list', {
          error: errorMessage(error),
        });
      }
    }
    await this.options.registry.setProjects(next);
  }
}
