import type { RunnerServerConfig } from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RunnerConnections } from './runner-connections';

/**
 * The config a runner is told to apply: the projects it watches (spec 10 D9).
 * `welcome` carries it on every connect; `push` resends it mid-connection.
 *
 * Each read-and-send runs in a per-runner queue, so a list read earlier is
 * never sent after one read later: the runner always ends on the newest list.
 */
@Injectable()
export class RunnerWatchList {
  private readonly logger = new Logger(RunnerWatchList.name);
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RunnerConnections,
  ) {}

  async configFor(runnerId: string): Promise<RunnerServerConfig> {
    const projects = await this.prisma.project.findMany({
      where: { runnerId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, rootPath: true },
    });
    return {
      projects: projects.map((p) => ({ id: p.id, root: p.rootPath })),
      pollIntervalsMs: {},
    };
  }

  /**
   * Reads the runner's config and hands it to `send`, which attaches the
   * connection and sends `welcome`. A `push` queued before it found no socket
   * and had already committed what this read sees; one queued after it finds
   * the socket and follows the welcome.
   */
  deliver(
    runnerId: string,
    send: (config: RunnerServerConfig) => void,
  ): Promise<void> {
    return this.serialize(runnerId, async () => {
      send(await this.configFor(runnerId));
    });
  }

  /**
   * Sends the runner its current list as a `config` message, if it is
   * connected. A runner that is not picks the list up at its next `welcome`.
   */
  push(runnerId: string): Promise<boolean> {
    return this.serialize(runnerId, async () => {
      if (!this.connections.get(runnerId)) return false;
      const config = await this.configFor(runnerId);
      const sent =
        this.connections.get(runnerId)?.send({ type: 'config', config }) ??
        false;
      if (sent) {
        this.logger.debug(
          `runner ${runnerId}: config pushed (${config.projects.length} projects)`,
        );
      }
      return sent;
    });
  }

  private serialize<T>(runnerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runnerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.queues.set(runnerId, settled);
    void settled.then(() => {
      if (this.queues.get(runnerId) === settled) this.queues.delete(runnerId);
    });
    return next;
  }
}
