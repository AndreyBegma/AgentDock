import {
  PANE_CAPTURE_INTERVAL_MS,
  PANE_FULL_RESEND_MS,
  PANE_HISTORY_LINES,
  PANE_MAX_FRAME_BYTES,
  PANE_MAX_SUBSCRIPTIONS,
  type PaneMessage,
  type PaneSubscribeErrorCode,
  type SubscribeErrorMessage,
  type SubscribeMessage,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { Cancel, Clock } from '../clock';
import { CommandFailure } from '../commands/failure';
import { resolveSlot } from '../control/target';
import { TmuxControl } from '../control/tmux';
import type { Exec } from '../detect/exec';
import { errorMessage, type Logger } from '../log';
import { capLines, diffLines, splitCapture } from './frame';
import { redact } from './redact';

export type PaneOutbound = PaneMessage | SubscribeErrorMessage;

export interface PaneStreamerOptions {
  exec: Exec;
  clock: Clock;
  /** The current watch list, as the server last sent it. */
  watchedProjects: () => readonly WatchedProject[];
  /** Sends to the server; false when the socket is not open. */
  send: (message: PaneOutbound) => boolean;
  log: Logger;
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
  intervalMs?: number;
  maxSubscriptions?: number;
  fullResendMs?: number;
  historyLines?: number;
  maxFrameBytes?: number;
}

interface Subscription {
  id: string;
  loop: Loop;
  /** The next frame for this subscription is a `full` one. */
  needsFull: boolean;
  lastFullAt: number;
}

interface Loop {
  key: string;
  session: string;
  subs: Map<string, Subscription>;
  /** The last capture, as every subscription of the loop last saw it. */
  previous: string[];
  busy: boolean;
  stopped: boolean;
  cancel: Cancel;
}

/**
 * The live pane streamer (spec 18). One capture loop per slot while any
 * subscription watches it; a subscription is a server-chosen id. Frames are
 * redacted, capped and diffed here — the control plane only relays them.
 */
export class PaneStreamer {
  private readonly subs = new Map<string, Subscription>();
  private readonly loops = new Map<string, Loop>();
  /** Ids being resolved; `true` once an `unsubscribe` or reset cancelled them. */
  private readonly pending = new Map<string, boolean>();
  private readonly tmuxServer: readonly string[];
  private readonly intervalMs: number;
  private readonly maxSubscriptions: number;
  private readonly fullResendMs: number;
  private readonly historyLines: number;
  private readonly maxFrameBytes: number;

  constructor(private readonly options: PaneStreamerOptions) {
    this.tmuxServer = options.tmuxServer ?? [];
    this.intervalMs = options.intervalMs ?? PANE_CAPTURE_INTERVAL_MS;
    this.maxSubscriptions = options.maxSubscriptions ?? PANE_MAX_SUBSCRIPTIONS;
    this.fullResendMs = options.fullResendMs ?? PANE_FULL_RESEND_MS;
    this.historyLines = options.historyLines ?? PANE_HISTORY_LINES;
    this.maxFrameBytes = options.maxFrameBytes ?? PANE_MAX_FRAME_BYTES;
  }

  /** Capture loops running; tests assert there is one per watched slot. */
  get loopCount(): number {
    return this.loops.size;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  async subscribe(message: SubscribeMessage): Promise<void> {
    const { id, projectId, root, slot } = message;
    if (this.subs.has(id) || this.pending.has(id)) return;
    const project = this.options
      .watchedProjects()
      .find((p) => p.id === projectId && p.root === root);
    if (!project) return this.refuse(id, 'forbidden');
    if (this.subs.size + this.pending.size >= this.maxSubscriptions) {
      return this.refuse(id, 'too_many_viewers');
    }

    this.pending.set(id, false);
    let session: string | null;
    try {
      session = await this.findSession(project, slot);
    } catch (error) {
      this.options.log.warn('pane: cannot resolve the slot', {
        error: errorMessage(error),
      });
      session = null;
    }
    const cancelled = this.pending.get(id) === true;
    this.pending.delete(id);
    if (cancelled) return;
    if (!session) return this.refuse(id, 'not_found');
    this.attach(id, `${root}\0${slot}`, session);
  }

  unsubscribe(id: string): void {
    if (this.pending.has(id)) this.pending.set(id, true);
    const sub = this.subs.get(id);
    if (sub) this.detach(sub);
  }

  /** The socket closed: the server resubscribes with new ids after reconnecting. */
  reset(): void {
    for (const id of this.pending.keys()) this.pending.set(id, true);
    for (const loop of [...this.loops.values()]) this.stopLoop(loop);
    this.subs.clear();
  }

  stop(): void {
    this.reset();
  }

  private refuse(id: string, code: PaneSubscribeErrorCode): void {
    this.options.send({ type: 'subscribe.error', id, code });
  }

  /** The slot's live session, or null when it is not a slot of this project. */
  private async findSession(
    project: WatchedProject,
    slot: string,
  ): Promise<string | null> {
    const tmux = new TmuxControl(this.options.exec, this.tmuxServer);
    try {
      const target = await resolveSlot(this.options.exec, tmux, project, slot);
      return [...target.sessions].sort()[0] ?? null;
    } catch (error) {
      if (error instanceof CommandFailure) return null;
      throw error;
    }
  }

  private attach(id: string, key: string, session: string): void {
    let loop = this.loops.get(key);
    const created = !loop;
    if (!loop) {
      loop = {
        key,
        session,
        subs: new Map(),
        previous: [],
        busy: false,
        stopped: false,
        cancel: () => {},
      };
      this.loops.set(key, loop);
    }
    const sub: Subscription = {
      id,
      loop,
      needsFull: true,
      lastFullAt: 0,
    };
    loop.subs.set(id, sub);
    this.subs.set(id, sub);
    if (created) {
      const started = loop;
      started.cancel = this.options.clock.setInterval(() => {
        void this.tick(started);
      }, this.intervalMs);
      void this.tick(started);
    }
  }

  private detach(sub: Subscription): void {
    this.subs.delete(sub.id);
    sub.loop.subs.delete(sub.id);
    if (sub.loop.subs.size === 0) this.stopLoop(sub.loop);
  }

  private stopLoop(loop: Loop): void {
    loop.stopped = true;
    loop.cancel();
    this.loops.delete(loop.key);
    for (const id of loop.subs.keys()) this.subs.delete(id);
    loop.subs.clear();
  }

  private async tick(loop: Loop): Promise<void> {
    if (loop.busy || loop.stopped) return;
    loop.busy = true;
    try {
      const result = await this.options.exec('tmux', [
        ...this.tmuxServer,
        'capture-pane',
        '-p',
        '-e',
        '-J',
        '-t',
        `=${loop.session}:`,
        '-S',
        `-${this.historyLines}`,
      ]);
      if (loop.stopped) return;
      // A capture that timed out says nothing about the session: try again.
      if (!result) return;
      if (result.code !== 0) return this.end(loop);
      const lines = capLines(
        redact(splitCapture(result.stdout)),
        this.maxFrameBytes,
      );
      await this.publish(loop, lines);
    } catch (error) {
      this.options.log.warn('pane: capture failed', {
        error: errorMessage(error),
      });
    } finally {
      loop.busy = false;
    }
  }

  private async publish(loop: Loop, lines: string[]): Promise<void> {
    const now = this.options.clock.now();
    const subs = [...loop.subs.values()];
    const wantsFull = (s: Subscription) =>
      s.needsFull || now - s.lastFullAt >= this.fullResendMs;
    const cursor = subs.some(wantsFull)
      ? await this.cursor(loop, lines.length)
      : null;
    if (loop.stopped) return;
    const patch = diffLines(loop.previous, lines);
    for (const sub of subs) {
      if (!loop.subs.has(sub.id)) continue;
      if (wantsFull(sub) && cursor) {
        this.options.send({
          type: 'pane',
          id: sub.id,
          frame: { type: 'full', lines, cursor },
        });
        sub.needsFull = false;
        sub.lastFullAt = now;
      } else if (patch) {
        this.options.send({
          type: 'pane',
          id: sub.id,
          frame: { type: 'patch', from: patch.from, lines: patch.lines },
        });
      }
    }
    loop.previous = lines;
  }

  /** The cursor as an index into `lines`; the end of the pane when tmux gives none. */
  private async cursor(
    loop: Loop,
    lineCount: number,
  ): Promise<{ x: number; y: number }> {
    const result = await this.options.exec('tmux', [
      ...this.tmuxServer,
      'display-message',
      '-p',
      '-t',
      `=${loop.session}:`,
      '#{pane_height} #{cursor_x} #{cursor_y}',
    ]);
    const [height, x, y] = (result?.code === 0 ? result.stdout : '')
      .trim()
      .split(' ')
      .map(Number);
    if (
      height === undefined ||
      x === undefined ||
      y === undefined ||
      ![height, x, y].every((n) => Number.isInteger(n) && n >= 0)
    ) {
      return { x: 0, y: Math.max(0, lineCount - 1) };
    }
    return { x, y: Math.max(0, lineCount - height + y) };
  }

  /** The session is gone (D7): the final frame, then the subscriptions are dropped. */
  private end(loop: Loop): void {
    for (const id of [...loop.subs.keys()]) {
      this.options.send({ type: 'pane', id, frame: { type: 'ended' } });
    }
    this.stopLoop(loop);
  }
}
