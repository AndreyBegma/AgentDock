import type { WatchedProject, WatchRefusal } from '@agentdock/shared/protocol';
import type { CollectorRegistry } from '../collectors';
import { errorMessage, type Logger } from '../log';

export interface WatchListOptions {
  /** The cached list from the runner config, used until the server speaks. */
  initial: readonly WatchedProject[];
  registry: CollectorRegistry;
  /** Writes the list to the runner config as the next boot's cache. */
  persist: (projects: WatchedProject[]) => void;
  /**
   * ADR-0047: why the runner-local policy refuses a project's root (outside
   * `allowedRoots`, a symlink out of them, not a git main checkout), or null
   * to watch it. Every list — the cached one and each the server sends — goes
   * through it; a refused project is left out, not watched.
   */
  admit: (project: WatchedProject) => Promise<string | null>;
  /**
   * #691: the projects the policy refuses, with why — on start and whenever
   * that set changes, `[]` once none is. The daemon sends it to the server as
   * `runner.watch_refused`, so the web can say why a project is not watched.
   */
  report?: (refused: WatchRefusal[]) => void;
  log: Logger;
}

const same = (a: readonly WatchedProject[], b: readonly WatchedProject[]) =>
  a.length === b.length &&
  a.every((p, i) => p.id === b[i].id && p.root === b[i].root);

/**
 * The projects this runner watches (D9). The server's list — `welcome` on
 * every connect, `config` after — is authoritative within the runner-local
 * policy (ADR-0047): a root the policy refuses is never watched. The config
 * file only caches the admitted list so collectors run before the first
 * connect.
 */
export class WatchList {
  private projects: WatchedProject[] = [];
  /** The last list asked for, before the policy: `reapply` re-checks it. */
  private requested: WatchedProject[];
  /** The refused set last reported; null before the first report. */
  private reported: string | null = null;

  constructor(private readonly options: WatchListOptions) {
    this.requested = options.initial.map((p) => ({ ...p }));
  }

  get current(): readonly WatchedProject[] {
    return this.projects;
  }

  /** Starts collectors for the cached list, as far as the policy admits it. */
  async start(): Promise<void> {
    this.projects = await this.admitted(this.requested);
    await this.options.registry.setProjects(this.projects);
  }

  /** The policy changed: the last list asked for is checked again. */
  reapply(): Promise<void> {
    return this.apply(this.requested);
  }

  private async admitted(
    projects: readonly WatchedProject[],
  ): Promise<WatchedProject[]> {
    const verdicts = await Promise.all(
      projects.map((p) =>
        this.options.admit(p).catch((error) => errorMessage(error)),
      ),
    );
    const refused: WatchRefusal[] = [];
    const admitted = projects.filter((p, i) => {
      const reason = verdicts[i];
      if (reason === null) return true;
      this.options.log.warn('watch list: project refused by policy', {
        projectId: p.id,
        reason,
      });
      refused.push({ projectId: p.id, message: reason });
      return false;
    });
    this.report(refused);
    return admitted;
  }

  private report(refused: WatchRefusal[]): void {
    const key = JSON.stringify(refused);
    if (key === this.reported) return;
    this.reported = key;
    this.options.report?.(refused);
  }

  /** Applies the server's list: collectors follow it, the cache is rewritten when it changed. */
  async apply(projects: readonly WatchedProject[]): Promise<void> {
    this.requested = projects.map((p) => ({ ...p }));
    projects = await this.admitted(projects);
    // The App health (spec 27 D12) and the content flag (spec 201 D13) live
    // in memory only: the config cache must not make a restarted runner trust
    // a health, or ship content, the server has not confirmed.
    const next = projects.map((p) => ({
      id: p.id,
      root: p.root,
      ...(p.githubApp ? { githubApp: p.githubApp } : {}),
      ...(p.shipContent ? { shipContent: true } : {}),
    }));
    const changed = !same(this.projects, next);
    this.projects = next;
    if (changed) {
      this.options.log.info('watch list changed', { projects: next.length });
      try {
        this.options.persist(next.map((p) => ({ id: p.id, root: p.root })));
      } catch (error) {
        this.options.log.warn('cannot cache the watch list', {
          error: errorMessage(error),
        });
      }
    }
    await this.options.registry.setProjects(next);
  }
}
