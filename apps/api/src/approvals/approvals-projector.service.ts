import {
  APPROVALS_LIVE_EVENT,
  type ApprovalsLiveChange,
  CURRENT_APPROVAL_STATUSES,
  configMergeApproval,
  FLEET_CHANNEL_WINDOW_MS,
} from '@agentdock/shared';
import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import {
  type CurrentRow,
  type PrAction,
  planPr,
  type RootTouch,
  readApprovalEvents,
  type SlotState,
} from './approval-rules';
import { ApprovalsService, lockApprovals } from './approvals.service';

type Tx = Prisma.TransactionClient;

interface ProjectRef {
  id: string;
  rootPath: string;
  codeSentinelConfig: Prisma.JsonValue;
}

/** What one project's batch changed, and which approved PRs need a head check. */
interface ProjectOutcome {
  changed: boolean;
  recheck: number[];
}

/** A batch of 500 events is a few queries per PR; well under this. */
const TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Turns runner events into `merge_approvals` rows (spec 20 D2, "API"):
 * `pr.awaiting_approval` opens a waiting row; `pr.opened`,
 * `pr.checks_changed` and a `pull request open` checkpoint derive one (no
 * plugin events) or drop an undecided one; `pr.closed` / `pr.merged` close
 * the current row. Runs after the fleet sink, so slots already reflect the
 * batch. A replayed event is a no-op: its `(runnerId, seq)` is already stored.
 * Approved PRs that moved get their head re-read after the transaction (D6).
 */
@Injectable()
export class ApprovalsProjector {
  private readonly logger = new Logger(ApprovalsProjector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly approvals: ApprovalsService,
  ) {}

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    const outcomes = await this.project(runnerId, events);
    for (const [projectId, outcome] of outcomes) {
      if (outcome.changed) {
        const change: ApprovalsLiveChange = { kind: 'approvals', projectId };
        this.live.publish(`project:${projectId}`, APPROVALS_LIVE_EVENT, change);
      }
      if (outcome.recheck.length > 0) {
        // Never blocks ingest: the batch is acknowledged without waiting on gh.
        void this.approvals.recheckHeads(projectId, outcome.recheck);
      }
    }
  }

  /** Applies the batch; returns each touched project's outcome. */
  async project(
    runnerId: string,
    events: RunnerEvent[],
  ): Promise<Map<string, ProjectOutcome>> {
    const roots = readApprovalEvents(await this.unseen(runnerId, events));
    const outcomes = new Map<string, ProjectOutcome>();
    if (roots.size === 0) return outcomes;

    const projects = await this.prisma.project.findMany({
      where: { runnerId, rootPath: { in: [...roots.keys()] } },
      select: { id: true, rootPath: true, codeSentinelConfig: true },
      orderBy: { id: 'asc' },
    });
    const now = new Date();
    for (const project of projects) {
      const touch = roots.get(project.rootPath);
      if (
        !touch ||
        (touch.prs.size === 0 && touch.checkpointSlots.size === 0)
      ) {
        continue;
      }
      const deriveAllowed = await this.deriveAllowed(
        runnerId,
        project,
        touch,
        now,
      );
      const outcome = await this.prisma.$transaction(
        async (tx) => {
          await lockApprovals(tx, project.id);
          return this.apply(tx, project, touch, deriveAllowed, now);
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      outcomes.set(project.id, outcome);
    }
    return outcomes;
  }

  /** Drops events already stored — a batch resent after a lost ack. */
  private async unseen(
    runnerId: string,
    events: RunnerEvent[],
  ): Promise<RunnerEvent[]> {
    const relevant = events.filter((e) => e.project);
    if (relevant.length === 0) return [];
    const stored = await this.prisma.event.findMany({
      where: { runnerId, seq: { in: relevant.map((e) => BigInt(e.seq)) } },
      select: { seq: true },
    });
    if (stored.length === 0) return relevant;
    const seen = new Set(stored.map((s) => Number(s.seq)));
    return relevant.filter((e) => !seen.has(e.seq));
  }

  /**
   * D2: derive only when the project's config asks for approval and no
   * plugin event for it arrived within the fleet channel window.
   */
  private async deriveAllowed(
    runnerId: string,
    project: ProjectRef,
    touch: RootTouch,
    now: Date,
  ): Promise<boolean> {
    const config = project.codeSentinelConfig as {
      orchestrator?: Record<string, unknown>;
      error?: string;
    } | null;
    if (configMergeApproval(config) !== true || touch.pluginEvent) return false;
    const recent = await this.prisma.event.findFirst({
      where: {
        runnerId,
        projectRoot: project.rootPath,
        source: 'code-sentinel',
        receivedAt: { gte: new Date(now.getTime() - FLEET_CHANNEL_WINDOW_MS) },
      },
      select: { id: true },
    });
    return recent === null;
  }

  private async apply(
    tx: Tx,
    project: ProjectRef,
    touch: RootTouch,
    deriveAllowed: boolean,
    now: Date,
  ): Promise<ProjectOutcome> {
    const prs = new Map(touch.prs);
    // A `pull request open` checkpoint without a number: the slot knows it.
    if (touch.checkpointSlots.size > 0) {
      const slots = await tx.slot.findMany({
        where: {
          projectId: project.id,
          name: { in: [...touch.checkpointSlots] },
          prNumber: { not: null },
          endedAt: null,
        },
        select: { prNumber: true },
      });
      for (const { prNumber } of slots) {
        if (prNumber === null) continue;
        const existing = prs.get(prNumber);
        prs.set(
          prNumber,
          existing
            ? { ...existing, moved: true }
            : { awaiting: null, closed: null, moved: true },
        );
      }
    }

    const outcome: ProjectOutcome = { changed: false, recheck: [] };
    for (const [pr, prTouch] of [...prs].sort(([a], [b]) => a - b)) {
      const current = await tx.mergeApproval.findFirst({
        where: {
          projectId: project.id,
          prNumber: pr,
          status: { in: [...CURRENT_APPROVAL_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, source: true },
      });
      const latest = current
        ? null
        : await tx.mergeApproval.findFirst({
            where: { projectId: project.id, prNumber: pr },
            orderBy: { createdAt: 'desc' },
            select: { id: true, status: true },
          });
      const actions = planPr({
        touch: prTouch,
        current: current as CurrentRow | null,
        closedRowId: latest?.status === 'closed' ? latest.id : null,
        slot: await this.slotOf(tx, project.id, pr),
        deriveAllowed,
        now: now.toISOString(),
      });
      for (const action of actions) {
        if (action.kind === 'checkHead') {
          outcome.recheck.push(pr);
          continue;
        }
        await this.perform(tx, project.id, pr, action);
        outcome.changed = true;
      }
    }
    return outcome;
  }

  private async perform(
    tx: Tx,
    projectId: string,
    pr: number,
    action: Exclude<PrAction, { kind: 'checkHead' }>,
  ): Promise<void> {
    switch (action.kind) {
      case 'create':
        await tx.mergeApproval.create({
          data: {
            projectId,
            prNumber: pr,
            slot: action.slot,
            issue: action.issue,
            source: action.source,
            status: 'waiting',
            waitingSince: new Date(action.waitingSince),
          },
        });
        return;
      case 'adopt':
        await tx.mergeApproval.update({
          where: { id: action.rowId },
          data: {
            source: 'orchestrator',
            ...(action.slot ? { slot: action.slot } : {}),
            ...(action.issue ? { issue: action.issue } : {}),
          },
        });
        return;
      case 'drop':
        await tx.mergeApproval.delete({ where: { id: action.rowId } });
        return;
      case 'close':
        await tx.mergeApproval.update({
          where: { id: action.rowId },
          data: { status: action.status },
        });
        this.logger.debug(
          `PR #${pr} on project ${projectId}: ${action.status}`,
        );
        return;
    }
  }

  /** The PR's latest slot after the fleet projector applied the batch. */
  private async slotOf(
    tx: Tx,
    projectId: string,
    pr: number,
  ): Promise<{ name: string; issue: number | null; state: SlotState } | null> {
    const slot = await tx.slot.findFirst({
      where: { projectId, prNumber: pr },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        issue: true,
        prState: true,
        prChecks: true,
        prMergeable: true,
        endedAt: true,
      },
    });
    if (!slot) return null;
    const checkpoint = await tx.slotCheckpoint.findFirst({
      where: { slotId: slot.id, kind: 'pr_open' },
      select: { id: true },
    });
    return {
      name: slot.name,
      issue: slot.issue,
      state: {
        prState: slot.prState,
        prChecks: slot.prChecks,
        prMergeable: slot.prMergeable,
        ended: slot.endedAt !== null,
        prOpenCheckpoint: checkpoint !== null,
      },
    };
  }
}
