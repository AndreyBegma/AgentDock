import { randomUUID } from 'node:crypto';
import type { LiveErrorCode, LiveTopic } from '@agentdock/shared';
import {
  isTerminalSkillRunPhase,
  RUN_LOG_LIVE_EVENTS,
  type RunLogFrame,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { type LiveClient, LiveConnections } from '../live/live-connections';
import type { LiveTopicHooks } from '../live/live-topic-hooks';
import {
  type RunnerStreamListener,
  type RunnerStreamMessage,
  RunnerStreams,
} from '../runners/runner-streams';
import { parseRunTopic } from './run-topic';

/** One watched run: its browsers and the runner subscription feeding them. */
interface RunWatch {
  readonly topic: LiveTopic;
  readonly projectId: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly viewers: Set<LiveClient>;
  /** The runner subscription's id; null while offline, after `ended`, or after a refusal. */
  id: string | null;
}

/**
 * The skill run live log (spec 24 D13), on the pane relay's pattern (#18):
 * one runner `run_log` subscription per watched run, however many browsers
 * watch it. A new viewer resubscribes, so the runner replays its backlog; the
 * last one leaving unsubscribes. Rendered lines are relayed as `/live`
 * events and never stored. A run that already ended is not subscribed: its
 * report is in `skill_runs`.
 *
 * Transitions run on one queue, in arrival order.
 */
@Injectable()
export class RunLogRelay implements LiveTopicHooks, RunnerStreamListener {
  readonly name = 'run_log';
  private readonly logger = new Logger(RunLogRelay.name);
  private readonly watches = new Map<LiveTopic, RunWatch>();
  /** Runner subscription id → topic. */
  private readonly byId = new Map<string, LiveTopic>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly connections: LiveConnections,
    private readonly streams: RunnerStreams,
  ) {}

  /** Resolves once every transition queued so far has run (tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  // LiveTopicHooks

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
        this.byId.delete(watch.id);
        watch.id = null;
      }
    });
  }

  message(runnerId: string, message: RunnerStreamMessage): void {
    // Panes are the pane relay's (#18).
    if (message.type === 'pane') return;
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
        this.logger.error(`run log relay: ${(error as Error).message}`);
      }
    });
  }

  private async join(client: LiveClient, topic: LiveTopic): Promise<void> {
    if (!client.topics.has(topic)) return;
    let watch = this.watches.get(topic);
    if (!watch) {
      const opened = await this.open(topic);
      if (!opened || !client.topics.has(topic)) return;
      watch = opened;
      this.watches.set(topic, watch);
    }
    if (watch.viewers.has(client)) return;
    watch.viewers.add(client);
    this.restart(watch);
  }

  private leave(client: LiveClient, topic: LiveTopic): void {
    const watch = this.watches.get(topic);
    if (!watch?.viewers.delete(client)) return;
    if (watch.viewers.size > 0) return;
    this.stop(watch);
    this.watches.delete(topic);
  }

  /** The run a newly watched topic streams from; null if it is gone or over. */
  private async open(topic: LiveTopic): Promise<RunWatch | null> {
    const { projectId, runId } = parseRunTopic(topic);
    const run = await this.prisma.skillRun.findFirst({
      where: { runId, run: { projectId, kind: 'skill' } },
      select: {
        phase: true,
        run: { select: { project: { select: { runnerId: true } } } },
      },
    });
    if (!run || isTerminalSkillRunPhase(run.phase)) return null;
    return {
      topic,
      projectId,
      runId,
      runnerId: run.run.project.runnerId,
      viewers: new Set(),
      id: null,
    };
  }

  private restart(watch: RunWatch): void {
    if (watch.viewers.size === 0) return;
    this.stop(watch);
    const id = `runlog_${randomUUID()}`;
    const sent = this.streams.send(watch.runnerId, {
      type: 'subscribe',
      id,
      kind: 'run_log',
      projectId: watch.projectId,
      runId: watch.runId,
    });
    if (!sent) return;
    watch.id = id;
    this.byId.set(id, watch.topic);
  }

  private stop(watch: RunWatch): void {
    if (watch.id === null) return;
    this.streams.send(watch.runnerId, { type: 'unsubscribe', id: watch.id });
    this.byId.delete(watch.id);
    watch.id = null;
  }

  /** A stale id, another relay's id or another runner's is dropped. */
  private watchOf(runnerId: string, id: string): RunWatch | null {
    const topic = this.byId.get(id);
    const watch = topic ? this.watches.get(topic) : undefined;
    if (!watch || watch.runnerId !== runnerId) return null;
    return watch;
  }

  private relay(watch: RunWatch, frame: RunLogFrame): void {
    if (frame.type === 'ended') {
      if (watch.id !== null) this.byId.delete(watch.id);
      watch.id = null;
      this.live.publish(watch.topic, RUN_LOG_LIVE_EVENTS.ended, frame);
      return;
    }
    this.live.publish(watch.topic, RUN_LOG_LIVE_EVENTS.lines, frame);
  }

  private refused(watch: RunWatch, code: LiveErrorCode): void {
    if (watch.id !== null) this.byId.delete(watch.id);
    watch.id = null;
    for (const client of [...watch.viewers]) {
      this.connections.unsubscribe(client, watch.topic);
      client.send({ type: 'error', topic: watch.topic, code });
    }
  }
}
