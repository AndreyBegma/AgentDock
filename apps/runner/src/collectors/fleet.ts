import { type FSWatcher, watch } from 'node:fs';
import type { Cancel } from '../clock';
import {
  type FleetEmitter,
  type FleetProject,
  fleetEmitter,
  resolveFleetProject,
} from '../fleet/project';
import { SlotBook } from '../fleet/slots';
import { errorMessage } from '../log';
import { BoardWatcher } from './board/board';
import { OrchestratorWatcher } from './orchestrator/orchestrator';
import { PrWatcher } from './prs/prs';
import type {
  Collector,
  CollectorContext,
  CollectorFactory,
  Emit,
  WatchedProject,
} from './registry';
import { ReplyWatcher } from './replies/replies';
import { SlotSessions } from './tmux/sessions';
import { Tmux } from './tmux/tmux';
import { WorktreeWatcher } from './worktrees/worktrees';

/** Board and reply files are rescanned this often even without a change notice (D3). */
export const FILE_RESCAN_MS = 60_000;
/** A burst of file changes is read once, this long after the first. */
export const FILE_DEBOUNCE_MS = 500;

export interface FleetCollectorOptions {
  /** Selects the tmux server: `['-L', name]` for a private socket (tests). */
  tmuxServer?: readonly string[];
  /** `fs.watch` the board and worktree directories; the rescan runs regardless. */
  watchFiles?: boolean;
}

interface Watchers {
  project: FleetProject;
  emit: FleetEmitter;
  book: SlotBook;
  tmux: Tmux;
  board: BoardWatcher;
  worktrees: WorktreeWatcher;
  sessions: SlotSessions;
  orchestrator: OrchestratorWatcher;
  replies: ReplyWatcher;
  prs: PrWatcher;
}

/**
 * Fleet observation for one project (spec 11): the tmux, worktree, board,
 * reply, PR and orchestrator collectors, on their intervals. Every step is
 * guarded — a tool that is missing or a file that does not parse is logged and
 * skipped, and the next interval tries again. Nothing here throws into the
 * daemon.
 */
export class FleetCollector implements Collector {
  readonly name = 'fleet';
  private watchers: Watchers | null = null;
  private timers: Cancel[] = [];
  private fsWatchers = new Map<string, FSWatcher>();
  private debounce: Cancel | null = null;
  private busy = new Set<string>();
  private stopped = false;
  private first: Promise<void> = Promise.resolve();
  private tmuxDown = false;

  constructor(
    private readonly context: CollectorContext,
    private readonly options: FleetCollectorOptions = {},
  ) {}

  async start(watched: WatchedProject, emit: Emit): Promise<void> {
    const { exec, clock, fleet } = this.context;
    const project = await resolveFleetProject(exec, watched);
    const fleetEmit = fleetEmitter(project, clock, emit);
    const book = new SlotBook();
    const tmux = new Tmux(exec, this.options.tmuxServer);
    const capture = (paneId: string) => tmux.capture(paneId);
    const now = () => clock.now();
    const shared = { project, book, emit: fleetEmit };
    this.watchers = {
      ...shared,
      tmux,
      board: new BoardWatcher({ ...shared, now }),
      worktrees: new WorktreeWatcher({ ...shared, exec, now }),
      sessions: new SlotSessions({ ...shared, capture }),
      orchestrator: new OrchestratorWatcher({
        exec,
        project,
        emit: fleetEmit,
        capture,
      }),
      replies: new ReplyWatcher({ book, emit: fleetEmit }),
      prs: new PrWatcher({ ...shared, exec, log: this.context.log }),
    };

    // Briefs first (they start runs), then sessions, then what hangs off them.
    this.first = this.guard('files', () => this.scanFiles())
      .then(() => this.guard('tick', () => this.tick()))
      .then(() => this.guard('files', () => this.scanFiles()))
      .then(() => this.guard('prs', () => this.prs()));
    this.timers.push(
      clock.setInterval(
        () => void this.guard('tick', () => this.tick()),
        fleet.pollSeconds * 1000,
      ),
      clock.setInterval(
        () => void this.guard('files', () => this.scanFiles()),
        FILE_RESCAN_MS,
      ),
      clock.setInterval(
        () => void this.guard('prs', () => this.prs()),
        fleet.prPollSeconds * 1000,
      ),
    );
  }

  /** Resolves once the first full pass after `start` has run. */
  settled(): Promise<void> {
    return this.first;
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.timers) cancel();
    this.timers = [];
    this.debounce?.();
    for (const watcher of this.fsWatchers.values()) watcher.close();
    this.fsWatchers.clear();
  }

  /** Sessions, worktrees, panes, orchestrator: the 15 s poll. */
  async tick(): Promise<void> {
    const w = this.watchers;
    if (!w) return;
    await w.worktrees.poll();
    const panes = await w.tmux.panes();
    if (panes === null) {
      if (!this.tmuxDown) {
        this.tmuxDown = true;
        this.context.log.warn('fleet: tmux unavailable', {
          projectId: w.project.id,
        });
      }
    } else {
      this.tmuxDown = false;
      await w.sessions.poll(panes);
      await w.orchestrator.poll(panes);
    }
    this.armFileWatchers();
  }

  /** Boards, briefs and reply files. */
  async scanFiles(): Promise<void> {
    const w = this.watchers;
    if (!w) return;
    w.board.scan();
    w.replies.scan();
  }

  async prs(): Promise<void> {
    await this.watchers?.prs.poll();
  }

  /** Runs one step unless it is still running from the last interval; never throws. */
  private async guard(step: string, run: () => Promise<void>): Promise<void> {
    if (this.stopped || this.busy.has(step)) return;
    this.busy.add(step);
    try {
      await run();
    } catch (error) {
      this.context.log.warn('fleet: step failed', {
        step,
        projectId: this.watchers?.project.id,
        error: errorMessage(error),
      });
    } finally {
      this.busy.delete(step);
    }
  }

  /** Watches the board directory and every slot worktree; a change schedules a file scan. */
  private armFileWatchers(): void {
    const w = this.watchers;
    if (!w || this.stopped || this.options.watchFiles === false) return;
    const wanted = new Map<string, boolean>([[w.project.boardDir, true]]);
    for (const worktree of w.book.worktrees.values()) {
      wanted.set(worktree.path, false);
    }
    for (const [path, watcher] of this.fsWatchers) {
      if (wanted.has(path)) continue;
      watcher.close();
      this.fsWatchers.delete(path);
    }
    for (const [path, recursive] of wanted) {
      if (this.fsWatchers.has(path)) continue;
      try {
        const watcher = watch(path, { recursive, persistent: false }, () =>
          this.scheduleScan(),
        );
        watcher.on('error', () => {
          watcher.close();
          this.fsWatchers.delete(path);
        });
        this.fsWatchers.set(path, watcher);
      } catch {
        // Not there yet (no board written so far): the rescan covers it.
      }
    }
  }

  private scheduleScan(): void {
    if (this.debounce || this.stopped) return;
    this.debounce = this.context.clock.setTimeout(() => {
      this.debounce = null;
      void this.guard('files', () => this.scanFiles());
    }, FILE_DEBOUNCE_MS);
  }
}

export const fleetCollector: CollectorFactory = (context) =>
  new FleetCollector(context);
