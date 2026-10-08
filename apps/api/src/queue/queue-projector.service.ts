import { QUEUE_LIVE_EVENT, type QueueLiveChange } from '@agentdock/shared';
import {
  type IssueClosedData,
  type IssuesSnapshotData,
  type IssuesUnavailableData,
  isFleetEventType,
  parseQueueEvent,
  type QueueEvent,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { QueueRecompute } from './queue-recompute';

type Tx = Prisma.TransactionClient;

interface ProjectRef {
  id: string;
  repo: string;
}

/** A batch of 500 events is a few queries each; well under this. */
const TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Turns a runner's queue events into `issues_cache` and `issue_feeds`, then
 * recomputes `queue_states` of every project the batch touched (spec 19 D2,
 * D3, D9). A fleet event (#11) — a round decided, a slot or a pull request
 * moving — also recomputes its project, after the fleet projector has
 * applied it. Fed every incoming batch by the runner event sink:
 * - data that does not fit is logged and skipped, never thrown;
 * - a database failure throws, which fails the batch so the runner resends;
 * - a resent or replayed event is a no-op (`lastSeq` on the feed and each row).
 */
@Injectable()
export class QueueProjector {
  private readonly logger = new Logger(QueueProjector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly recompute: QueueRecompute,
  ) {}

  /** Projects the batch, then publishes `queue` on every project that changed. */
  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const projectId of await this.project(runnerId, events)) {
      const change: QueueLiveChange = { kind: 'queue', projectId };
      this.live.publish(`project:${projectId}`, QUEUE_LIVE_EVENT, change);
    }
  }

  /** Projects the batch in one transaction; returns the projects that changed. */
  async project(runnerId: string, events: RunnerEvent[]): Promise<string[]> {
    const queue: QueueEvent[] = [];
    const touched = new Set<string>();
    for (const raw of events) {
      if (isFleetEventType(raw.type)) {
        if (raw.project) touched.add(raw.project.root);
        continue;
      }
      const parsed = parseQueueEvent(raw);
      if (!parsed) continue;
      if (!parsed.ok) {
        this.logger.warn(
          `skipped queue event seq ${raw.seq}: ${parsed.reason}`,
        );
        continue;
      }
      queue.push(parsed.event);
      touched.add(parsed.event.project.root);
    }
    if (touched.size === 0) return [];
    queue.sort((a, b) => a.seq - b.seq);

    const projects = new Map(
      (
        await this.prisma.project.findMany({
          where: { runnerId, rootPath: { in: [...touched] } },
          select: { id: true, repo: true, rootPath: true },
        })
      ).map((p) => [p.rootPath, p]),
    );
    if (projects.size === 0) return [];

    const changed = new Set<string>();
    await this.prisma.$transaction(
      async (tx) => {
        // One projector per runner at a time, across API instances too.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`queue:${runnerId}`}))`;
        for (const event of queue) {
          const project = projects.get(event.project.root);
          if (project && (await this.apply(tx, project, event))) {
            changed.add(project.id);
          }
        }
        for (const project of projects.values()) {
          if (await this.recompute.run(tx, project.id)) changed.add(project.id);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return [...changed];
  }

  /** Applies one event; true when it changed something a client shows. */
  private apply(
    tx: Tx,
    project: ProjectRef,
    event: QueueEvent,
  ): Promise<boolean> {
    const seq = BigInt(event.seq);
    switch (event.type) {
      case 'issues.snapshot':
        return this.snapshot(tx, project, event.data, seq);
      case 'issue.closed':
        return this.closed(tx, project, event.data, seq, new Date(event.ts));
      case 'issues.unavailable':
        return this.unavailable(
          tx,
          project,
          event.data,
          seq,
          new Date(event.ts),
        );
    }
  }

  private async snapshot(
    tx: Tx,
    project: ProjectRef,
    data: IssuesSnapshotData,
    seq: bigint,
  ): Promise<boolean> {
    const feed = await tx.issueFeed.findUnique({
      where: { projectId: project.id },
    });
    // Snapshots are complete: an older one replayed after a newer one is stale.
    if (feed && seq <= feed.lastSeq) return false;
    const fetchedAt = new Date(data.fetchedAt);
    const feedData = {
      fetchedAt,
      snapshotId: data.snapshotId,
      unavailableReason: null,
      unavailableAt: null,
      lastSeq: seq,
    };
    await tx.issueFeed.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id, ...feedData },
      update: feedData,
    });

    const rows: Row[] = [
      ...data.issues.map((i) => ({
        number: i.number,
        kind: 'issue' as const,
        title: i.title,
        labels: i.labels,
        assignees: i.assignees,
        body: i.body,
        url: i.url,
        ghUpdatedAt: new Date(i.updatedAt),
      })),
      ...data.pullRequests.map((p) => ({
        number: p.number,
        kind: 'pull_request' as const,
        title: p.title,
        labels: [],
        assignees: [],
        body: p.body,
        url: p.url,
        ghUpdatedAt: new Date(p.updatedAt),
      })),
    ];
    const existing = new Map(
      (
        await tx.issueCache.findMany({
          where: {
            projectId: project.id,
            number: { in: rows.map((r) => r.number) },
          },
        })
      ).map((r) => [r.number, r]),
    );
    for (const row of rows) {
      const before = existing.get(row.number);
      if (before && seq <= before.lastSeq) continue;
      const content = { ...row, state: 'open' as const };
      if (!before) {
        await tx.issueCache.create({
          data: {
            projectId: project.id,
            ...content,
            snapshotAt: fetchedAt,
            lastSeq: seq,
          },
        });
        continue;
      }
      const same = sameContent(before, content);
      await tx.issueCache.update({
        where: { id: before.id },
        // A comment moves GitHub's `updatedAt` but not what D3 reads, so it
        // does not make the issue fresher than the orchestrator's round (D4).
        data: same
          ? { ghUpdatedAt: row.ghUpdatedAt, lastSeq: seq }
          : {
              ...content,
              // Reopened: the old closure no longer applies.
              closedBy: null,
              closingPr: null,
              closedAt: null,
              snapshotAt: fetchedAt,
              lastSeq: seq,
            },
      });
    }

    // Every part carries the complete open list: what is not in it is closed.
    await tx.issueCache.updateMany({
      where: {
        projectId: project.id,
        state: 'open',
        number: { notIn: data.open },
        lastSeq: { lt: seq },
      },
      data: { state: 'closed', snapshotAt: fetchedAt, lastSeq: seq },
    });
    return true;
  }

  private async closed(
    tx: Tx,
    project: ProjectRef,
    data: IssueClosedData,
    seq: bigint,
    ts: Date,
  ): Promise<boolean> {
    const closure = {
      state: 'closed' as const,
      closedBy: data.closedBy,
      closingPr: data.pr ?? null,
      closedAt: data.closedAt ? new Date(data.closedAt) : null,
      snapshotAt: ts,
      lastSeq: seq,
    };
    const before = await tx.issueCache.findUnique({
      where: {
        projectId_number: { projectId: project.id, number: data.number },
      },
    });
    if (before && seq <= before.lastSeq) return false;
    if (before) {
      await tx.issueCache.update({ where: { id: before.id }, data: closure });
      return true;
    }
    // A dependency closed before AgentDock first saw it: only its closure is known.
    await tx.issueCache.create({
      data: {
        projectId: project.id,
        number: data.number,
        kind: 'issue',
        title: '',
        labels: [],
        assignees: [],
        body: '',
        url: `https://github.com/${project.repo}/issues/${data.number}`,
        ghUpdatedAt: closure.closedAt ?? ts,
        ...closure,
      },
    });
    return true;
  }

  private async unavailable(
    tx: Tx,
    project: ProjectRef,
    data: IssuesUnavailableData,
    seq: bigint,
    ts: Date,
  ): Promise<boolean> {
    const feed = await tx.issueFeed.findUnique({
      where: { projectId: project.id },
    });
    if (feed && seq <= feed.lastSeq) return false;
    const update = {
      unavailableReason: data.reason,
      unavailableAt: ts,
      lastSeq: seq,
    };
    await tx.issueFeed.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id, ...update },
      update,
    });
    return true;
  }
}

interface Row {
  number: number;
  kind: 'issue' | 'pull_request';
  title: string;
  labels: string[];
  assignees: string[];
  body: string;
  url: string;
  ghUpdatedAt: Date;
}

const sameContent = (
  before: Prisma.IssueCacheGetPayload<object>,
  after: Row & { state: 'open' },
): boolean =>
  before.state === after.state &&
  before.kind === after.kind &&
  before.title === after.title &&
  before.body === after.body &&
  before.url === after.url &&
  JSON.stringify(before.labels) === JSON.stringify(after.labels) &&
  JSON.stringify(before.assignees) === JSON.stringify(after.assignees);
