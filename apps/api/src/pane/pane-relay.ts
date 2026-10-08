import { randomUUID } from 'node:crypto';
import {
  type AuditAction,
  type LiveErrorCode,
  type LiveTopic,
  MAX_LIVE_MESSAGE_BYTES,
} from '@agentdock/shared';
import {
  PANE_LIVE_EVENTS,
  PANE_MAX_VIEWERS_PER_SLOT,
  type PaneFrame,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { type LiveClient, LiveConnections } from '../live/live-connections';
import type { LiveTopicHooks } from '../live/live-topic-hooks';
import type {
  RunnerStreamListener,
  RunnerStreamMessage,
} from '../runners/runner-streams';
import { RunnerStreams } from '../runners/runner-streams';
import { chunkPaneFrame } from './pane-chunks';
import { parsePaneTopic } from './pane-topic';

/**
 * Room left in a `/live` frame for everything around `data`: the envelope
 * keys, a topic of at most 134 characters and the timestamp take under 250.
 */
const ENVELOPE_BYTES = 512;
const MAX_FRAME_DATA_BYTES = MAX_LIVE_MESSAGE_BYTES - ENVELOPE_BYTES;

/** One watched slot: its browsers and the runner subscription feeding them. */
interface PaneWatch {
  readonly topic: LiveTopic;
  readonly projectId: string;
  readonly slot: string;
  readonly runnerId: string;
  readonly root: string;
  readonly viewers: Set<LiveClient>;
  /**
   * The runner subscription's id; null while the runner is offline, after
   * `ended`, and after the runner refused it.
   */
  id: string | null;
}

/**
 * The pane fan-out (spec 18 D3, D4, D7, D8). One runner subscription per
 * watched slot, however many browsers watch it: the first viewer subscribes,
 * every later viewer resubscribes under a new id so the runner sends a fresh
 * `full` (frames are never cached here), the last one leaving unsubscribes.
 * Frames are relayed as `/live` events and never stored.
 *
 * Every transition runs on one queue, in arrival order, so a frame never
 * overtakes the join or leave before it.
 */
@Injectable()
export class PaneRelay implements LiveTopicHooks, RunnerStreamListener {
  readonly name = 'pane';
  private readonly logger = new Logger(PaneRelay.name);
  private readonly watches = new Map<LiveTopic, PaneWatch>();
  /** Runner subscription id → topic. Ids of finished subscriptions are removed. */
  private readonly byId = new Map<string, LiveTopic>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly connections: LiveConnections,
    private readonly streams: RunnerStreams,
    private readonly audit: AuditService,
  ) {}

  /** Resolves once every transition queued so far has run (tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  // LiveTopicHooks

  admit(_topic: LiveTopic, subscribers: number): LiveErrorCode | null {
    return subscribers >= PANE_MAX_VIEWERS_PER_SLOT ? 'too_many_viewers' : null;
  }

  joined(client: LiveClient, topic: LiveTopic): void {
    this.enqueue(() => this.join(client, topic));
  }

  left(client: LiveClient, topic: LiveTopic): void {
    this.enqueue(async () => this.leave(client, topic));
  }

  // RunnerStreamListener

  connected(runnerId: string): void {
    this.enqueue(async () => {
      for (const watch of this.watches.values()) {
        if (watch.runnerId === runnerId) this.restart(watch);
      }
    });
  }

  disconnected(runnerId: string): void {
    this.enqueue(async () => {
      for (const watch of this.watches.values()) {
        if (watch.runnerId !== runnerId || watch.id === null) continue;
        // The runner forgot it; `connected` subscribes again.
        this.byId.delete(watch.id);
        watch.id = null;
      }
    });
  }

  message(runnerId: string, message: RunnerStreamMessage): void {
    this.enqueue(async () => {
      const watch = this.watchOf(runnerId, message.id);
      if (!watch) return;
      if (message.type === 'subscribe.error') {
        this.refused(watch, message.code);
      } else {
        this.relay(watch, message.frame);
      }
    });
  }

  // Transitions

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      try {
        await task();
      } catch (error) {
        this.logger.error(`pane relay: ${(error as Error).message}`);
      }
    });
  }

  private async join(client: LiveClient, topic: LiveTopic): Promise<void> {
    // The socket may have left again while earlier work ran.
    if (!client.topics.has(topic)) return;
    let watch = this.watches.get(topic);
    if (!watch) {
      const opened = await this.open(topic);
      if (!opened || !client.topics.has(topic)) return;
      watch = opened;
      this.watches.set(topic, watch);
    }
    if (watch.viewers.has(client)) return;
    if (!this.watching(watch, client.user.id)) {
      this.record('pane.watch_started', watch, client.user.id);
    }
    watch.viewers.add(client);
    // First viewer: subscribe. Later ones: resubscribe for a fresh `full`.
    this.restart(watch);
  }

  private leave(client: LiveClient, topic: LiveTopic): void {
    const watch = this.watches.get(topic);
    if (!watch?.viewers.delete(client)) return;
    if (!this.watching(watch, client.user.id)) {
      this.record('pane.watch_stopped', watch, client.user.id);
    }
    if (watch.viewers.size > 0) return;
    this.stop(watch);
    this.watches.delete(topic);
  }

  /** The project a newly watched topic streams from; null if it is gone. */
  private async open(topic: LiveTopic): Promise<PaneWatch | null> {
    const { projectId, slot } = parsePaneTopic(topic);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { runnerId: true, rootPath: true },
    });
    if (!project) {
      this.logger.warn(`pane ${topic}: project not found, nothing to stream`);
      return null;
    }
    return {
      topic,
      projectId,
      slot,
      runnerId: project.runnerId,
      root: project.rootPath,
      viewers: new Set(),
      id: null,
    };
  }

  /** Drops the current runner subscription, if any, and opens a new one. */
  private restart(watch: PaneWatch): void {
    if (watch.viewers.size === 0) return;
    this.stop(watch);
    const id = `pane_${randomUUID()}`;
    const sent = this.streams.send(watch.runnerId, {
      type: 'subscribe',
      id,
      kind: 'pane',
      projectId: watch.projectId,
      root: watch.root,
      slot: watch.slot,
    });
    // Offline: `connected` subscribes when the runner is back.
    if (!sent) return;
    watch.id = id;
    this.byId.set(id, watch.topic);
  }

  private stop(watch: PaneWatch): void {
    if (watch.id === null) return;
    this.streams.send(watch.runnerId, { type: 'unsubscribe', id: watch.id });
    this.byId.delete(watch.id);
    watch.id = null;
  }

  /**
   * The watch a runner message belongs to. A stale id (resubscribed, stopped)
   * or another runner's id is dropped: a runner feeds only its own streams.
   */
  private watchOf(runnerId: string, id: string): PaneWatch | null {
    const topic = this.byId.get(id);
    const watch = topic ? this.watches.get(topic) : undefined;
    if (!watch || watch.runnerId !== runnerId) {
      this.logger.debug(`runner ${runnerId}: pane message for no stream`);
      return null;
    }
    return watch;
  }

  private relay(watch: PaneWatch, frame: PaneFrame): void {
    if (frame.type === 'ended') {
      // The runner dropped it; viewers keep the topic and the last frame (D7).
      if (watch.id !== null) this.byId.delete(watch.id);
      watch.id = null;
      this.live.publish(watch.topic, PANE_LIVE_EVENTS.ended, null);
      return;
    }
    for (const piece of chunkPaneFrame(frame, MAX_FRAME_DATA_BYTES)) {
      this.live.publish(watch.topic, PANE_LIVE_EVENTS.frame, piece);
    }
  }

  /** The runner refused the stream: every viewer gets the code and is unsubscribed. */
  private refused(watch: PaneWatch, code: LiveErrorCode): void {
    if (watch.id !== null) this.byId.delete(watch.id);
    watch.id = null;
    for (const client of [...watch.viewers]) {
      // Queues `leave` for each, which audits and forgets the watch.
      this.connections.unsubscribe(client, watch.topic);
      client.send({ type: 'error', topic: watch.topic, code });
    }
  }

  private watching(watch: PaneWatch, userId: string): boolean {
    for (const viewer of watch.viewers) {
      if (viewer.user.id === userId) return true;
    }
    return false;
  }

  /** Who watched which slot — never what they saw (D8). */
  private record(action: AuditAction, watch: PaneWatch, userId: string): void {
    void this.audit.record({
      actor: userActor(userId),
      action,
      target: { type: 'slot', id: watch.slot },
      projectId: watch.projectId,
      result: 'ok',
    });
  }
}
