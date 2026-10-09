import { parseDependsOn } from '@agentdock/shared';
import type {
  IssueClosedData,
  IssuesRefreshResult,
  QueueEventType,
} from '@agentdock/shared/protocol';
import { type Cancel, isoNow } from '../../clock';
import { type FleetProject, resolveFleetProject } from '../../fleet/project';
import { errorMessage } from '../../log';
import type {
  Collector,
  CollectorContext,
  CollectorFactory,
  Emit,
  WatchedProject,
} from '../registry';
import { fetchClosure } from './closure';
import { fetchListing, type Listing } from './listing';
import { type IssuesRefreshers, issuesRefreshers } from './refresh';
import { splitSnapshot } from './split';

/** Spec 19 D1 and Configuration: `queue.pollSeconds`, default 60. */
export const DEFAULT_ISSUES_POLL_SECONDS = 60;

export interface IssuesCollectorOptions {
  pollSeconds?: number;
  /** Where `issues.refresh` finds this collector; tests inject their own. */
  refreshers?: IssuesRefreshers;
}

type PassResult =
  | { kind: 'changed' | 'unchanged' }
  | { kind: 'unavailable'; reason: string };

/**
 * The project's open GitHub issues (spec 19 D1, D2), read through the
 * runner's own `gh`: a conditional request every poll, `issues.snapshot`
 * parts when the listing changed, `issue.closed` for each `Depends on` target
 * that is closed, and `issues.unavailable` — once — when the listing cannot
 * be read. Passes never overlap and never throw.
 */
export class IssuesCollector implements Collector {
  readonly name = 'issues';
  private project: FleetProject | null = null;
  private emitRaw: Emit | null = null;
  private timer: Cancel | null = null;
  private etag: string | null = null;
  private unavailable: string | null = null;
  private snapshots = 0;
  /** Closed dependencies whose closure has been reported since start. */
  private readonly reported = new Set<number>();
  /** Closed dependencies still to be looked up. */
  private readonly pending = new Set<number>();
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private first: Promise<unknown> = Promise.resolve();
  private readonly refresher = () => this.refresh();

  constructor(
    private readonly context: CollectorContext,
    private readonly options: IssuesCollectorOptions = {},
  ) {}

  async start(watched: WatchedProject, emit: Emit): Promise<void> {
    const { exec, clock } = this.context;
    this.project = await resolveFleetProject(exec, watched);
    this.emitRaw = emit;
    this.refreshers().register(watched.id, this.refresher);
    this.first = this.enqueue(false);
    this.timer = clock.setInterval(
      () => void this.enqueue(false),
      (this.options.pollSeconds ?? DEFAULT_ISSUES_POLL_SECONDS) * 1000,
    );
  }

  /** Resolves once the first pass after `start` has run. */
  settled(): Promise<unknown> {
    return this.first;
  }

  /** One conditional poll, as the interval runs it; resolves when it is done. */
  async tick(): Promise<void> {
    await this.enqueue(false);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.();
    this.timer = null;
    if (this.project) {
      this.refreshers().unregister(this.project.id, this.refresher);
    }
  }

  /**
   * `issues.refresh`: polls now, ignoring the ETag, after any pass in
   * progress. Throws the `gh` error when the listing cannot be read.
   */
  async refresh(): Promise<IssuesRefreshResult> {
    const result = await this.enqueue(true);
    if (result.kind === 'unavailable') throw new Error(result.reason);
    return {
      changed: result.kind === 'changed',
      fetchedAt: isoNow(this.context.clock),
    };
  }

  private refreshers(): IssuesRefreshers {
    return this.options.refreshers ?? issuesRefreshers;
  }

  private enqueue(force: boolean): Promise<PassResult> {
    const run = this.chain.then(() => this.pass(force));
    this.chain = run;
    return run;
  }

  private async pass(force: boolean): Promise<PassResult> {
    if (this.stopped) return { kind: 'unchanged' };
    try {
      return await this.poll(force);
    } catch (error) {
      const reason = errorMessage(error);
      this.context.log.warn('issues: pass failed', {
        projectId: this.project?.id,
        error: reason,
      });
      return { kind: 'unavailable', reason };
    }
  }

  private async poll(force: boolean): Promise<PassResult> {
    const { exec, clock } = this.context;
    const project = this.project as FleetProject;
    if (!project.github) return this.degrade('no GitHub remote');

    // After an outage the API shows "unavailable" until the next snapshot, so
    // the first successful read must be unconditional.
    const conditional = !force && this.unavailable === null;
    const fetched = await fetchListing({
      exec,
      repo: project.github,
      etag: conditional ? this.etag : null,
    });
    if (fetched.kind === 'unavailable') return this.degrade(fetched.reason);
    this.recover();

    if (fetched.kind === 'unchanged') {
      await this.resolveClosures(project.github);
      return { kind: 'unchanged' };
    }
    this.etag = fetched.etag;
    const fetchedAt = isoNow(clock);
    const snapshotId = `snap_${clock.now().toString(36)}_${++this.snapshots}`;
    for (const data of splitSnapshot(fetched.listing, {
      snapshotId,
      fetchedAt,
    })) {
      this.emit('issues.snapshot', data);
    }
    this.trackDependencies(fetched.listing);
    await this.resolveClosures(project.github);
    return { kind: 'changed' };
  }

  /** Every `Depends on #m` of the listing whose target is not open and not yet reported. */
  private trackDependencies(listing: Listing): void {
    const open = new Set(listing.open);
    for (const issue of listing.issues) {
      for (const dependency of parseDependsOn(issue.body)) {
        if (!open.has(dependency) && !this.reported.has(dependency)) {
          this.pending.add(dependency);
        }
      }
    }
  }

  /** Looks up each pending closure; one that cannot be read stays pending for the next tick. */
  private async resolveClosures(repo: string): Promise<void> {
    for (const number of [...this.pending]) {
      if (this.stopped) return;
      const closure: IssueClosedData | null = await fetchClosure(
        this.context.exec,
        repo,
        number,
      );
      if (!closure) continue;
      this.pending.delete(number);
      this.reported.add(number);
      this.emit('issue.closed', closure);
    }
  }

  private emit(type: QueueEventType, data: unknown): void {
    const project = this.project as FleetProject;
    this.emitRaw?.({
      v: 1,
      ts: isoNow(this.context.clock),
      type,
      source: 'runner',
      project: { repo: project.repo, root: project.root },
      data,
    });
  }

  /** `issues.unavailable` is emitted when the reason changes, not on every failed tick. */
  private degrade(reason: string): PassResult {
    if (this.unavailable !== reason) {
      this.unavailable = reason;
      this.context.log.warn('issues: unavailable', {
        projectId: this.project?.id,
        reason,
      });
      this.emit('issues.unavailable', { reason: reason.slice(0, 500) });
    }
    return { kind: 'unavailable', reason };
  }

  private recover(): void {
    if (this.unavailable === null) return;
    this.unavailable = null;
    this.context.log.info('issues: available again', {
      projectId: this.project?.id,
    });
  }
}

/** The `issues` collector (spec 19), one instance per watched project. */
export const issuesCollector =
  (options: IssuesCollectorOptions = {}): CollectorFactory =>
  (context) =>
    new IssuesCollector(context, options);
