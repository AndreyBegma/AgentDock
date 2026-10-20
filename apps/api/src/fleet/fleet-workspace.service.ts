import {
  buildFleetGraph,
  type ConversationEntry,
  FLEET_ERROR,
  type FleetGraph,
  SLOT_CONVERSATION_MAX_ENTRIES,
  type SlotConversation,
  type SlotWorktreeView,
} from '@nautelle/shared';
import {
  gitRefSchema,
  type Role,
  RUNNER_FEATURE_COMMANDS,
  slotMessageSeenDataSchema,
  slotNameSchema,
} from '@nautelle/shared/protocol';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { Slot, SlotCheckpoint } from '@prisma/client';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { toOrchestratorView } from './fleet-mapper';
import {
  FLEET_WORKSPACE_OPTIONS,
  type FleetWorkspaceOptions,
} from './fleet-workspace-options';

const fleetError = (
  status: number,
  error: string,
  message: string,
): HttpException =>
  new HttpException({ statusCode: status, error, message }, status);

const slotNotFound = () =>
  fleetError(404, FLEET_ERROR.slotNotFound, 'Slot not found');

export interface WorkspaceCaller {
  projectId: string;
  role: Role;
  ctx: AuditContext;
}

interface CachedWorktree {
  view: SlotWorktreeView;
  expiresAt: number;
}

/**
 * The agent workspace's reads (docs/specs/160-agent-workspace.md): the fleet
 * graph, a slot's conversation, and its worktree through the runner. Only
 * `worktree` talks to the runner; it never writes.
 */
@Injectable()
export class FleetWorkspaceService {
  private readonly worktrees = new Map<string, CachedWorktree>();
  private readonly pending = new Map<string, Promise<SlotWorktreeView>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
    @Inject(FLEET_WORKSPACE_OPTIONS)
    private readonly options: FleetWorkspaceOptions,
  ) {}

  /** A `:slot` route param, checked before anything is read or sent. */
  parseSlot(slot: string): string {
    const parsed = slotNameSchema.safeParse(slot);
    if (!parsed.success) {
      throw fleetError(400, FLEET_ERROR.invalidSlot, 'Not a slot name');
    }
    return parsed.data;
  }

  /**
   * Every slot that has not ended, plus the latest run of every other slot of
   * the same issues (a merged sibling stays on its wave as `done`), and the
   * cached issues those slots name.
   */
  async graph(projectId: string): Promise<FleetGraph> {
    const [orchestrator, active] = await Promise.all([
      this.prisma.fleetOrchestrator.findUnique({ where: { projectId } }),
      this.prisma.slot.findMany({
        where: { projectId, status: { not: 'ended' } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        include: { checkpoints: { select: { kind: true } } },
      }),
    ]);
    const numbers = [
      ...new Set(
        active.map((s) => s.issue).filter((n): n is number => n !== null),
      ),
    ];
    const [siblings, issues] = await Promise.all([
      numbers.length === 0
        ? []
        : this.prisma.slot.findMany({
            where: {
              projectId,
              issue: { in: numbers },
              status: 'ended',
            },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
            include: { checkpoints: { select: { kind: true } } },
          }),
      numbers.length === 0
        ? []
        : this.prisma.issueCache.findMany({
            where: { projectId, kind: 'issue', number: { in: numbers } },
            select: { number: true, title: true, body: true },
          }),
    ]);
    return buildFleetGraph({
      projectId,
      orchestrator: toOrchestratorView(orchestrator),
      slots: [...active, ...siblings].map((row) => ({
        id: row.id,
        name: row.name,
        issue: row.issue,
        runtime: row.runtime,
        model: row.model,
        modelWhy: row.modelWhy,
        lead: row.lead,
        branch: row.branch,
        round: row.round,
        status: row.status,
        lastCheckpoint: row.lastCheckpoint,
        checkpoints: row.checkpoints.map((c) => c.kind),
        prNumber: row.prNumber,
        prUrl: row.prUrl,
        prState: row.prState,
        prChecks: row.prChecks,
        startedAt: row.startedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      issues,
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * The latest run's conversation. A message belongs to the run that covers
   * its `ts` (the projector's rule, spec 11 D8): at or after this run's start.
   * A message file sent again unchanged (a runner restart) keeps its first
   * entry: one per `fileHash`.
   */
  async conversation(
    projectId: string,
    name: string,
  ): Promise<SlotConversation> {
    const [project, run] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { rootPath: true, runnerId: true },
      }),
      this.latestRun(projectId, name, true),
    ]);
    if (!project) throw projectNotFound();
    const events = await this.prisma.event.findMany({
      where: {
        type: 'slot.message_seen',
        runnerId: project.runnerId,
        projectRoot: project.rootPath,
        slot: name,
        ts: { gte: run.startedAt },
      },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      select: { id: true, ts: true, data: true },
    });

    const entries: ConversationEntry[] = [];
    const hashes = new Set<string>();
    for (const event of events) {
      const parsed = slotMessageSeenDataSchema.safeParse(event.data);
      if (!parsed.success || hashes.has(parsed.data.fileHash)) continue;
      hashes.add(parsed.data.fileHash);
      entries.push({
        from: 'orchestrator',
        id: `orchestrator:${event.id}`,
        at: event.ts.toISOString(),
        sender: parsed.data.sender ?? null,
        sentAt: parsed.data.sentAt ?? null,
        body: parsed.data.body,
        mode: parsed.data.mode,
      });
    }
    for (const checkpoint of run.checkpoints) {
      entries.push({
        from: 'worker',
        id: `worker:${checkpoint.id}`,
        at: checkpoint.at.toISOString(),
        checkpoint: checkpoint.kind,
        heading: checkpoint.heading,
        body: checkpoint.summary,
        position: checkpoint.position,
      });
    }
    // Stable: same-instant entries keep messages first, then reply-file order.
    entries.sort((a, b) => a.at.localeCompare(b.at));
    const truncated = Math.max(
      0,
      entries.length - SLOT_CONVERSATION_MAX_ENTRIES,
    );
    return {
      slot: name,
      slotId: run.id,
      entries: entries.slice(truncated),
      truncated,
    };
  }

  /**
   * `worktree.status` on the project's runner (spec 160), reused for
   * `worktreeCacheMs` per slot. The root comes from the project row, the base
   * from the latest round, else the project's base branch; nothing from the
   * caller but the slot name.
   */
  async worktree(
    caller: WorkspaceCaller,
    name: string,
  ): Promise<SlotWorktreeView> {
    const key = `${caller.projectId}\0${name}`;
    const cached = this.worktrees.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.view;
    const running = this.pending.get(key);
    if (running) return running;
    const request = this.fetchWorktree(caller, name).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, request);
    return request;
  }

  private async fetchWorktree(
    caller: WorkspaceCaller,
    name: string,
  ): Promise<SlotWorktreeView> {
    const [project, latestRound] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: caller.projectId },
        select: {
          runnerId: true,
          rootPath: true,
          baseBranch: true,
          baseOverride: true,
        },
      }),
      this.prisma.round.findFirst({
        where: { projectId: caller.projectId },
        orderBy: [{ date: 'desc' }, { label: 'desc' }],
        select: { base: true },
      }),
      this.latestRun(caller.projectId, name, false),
    ]);
    if (!project) throw projectNotFound();
    if (!this.presence.isConnected(project.runnerId)) {
      throw fleetError(
        409,
        FLEET_ERROR.runnerOffline,
        'The runner is not connected',
      );
    }
    if (
      this.presence.missingCommand(
        project.runnerId,
        RUNNER_FEATURE_COMMANDS.worktree,
      )
    ) {
      throw fleetError(
        409,
        FLEET_ERROR.runnerOutdated,
        'The runner does not serve worktree.status; update it',
      );
    }
    const base = gitRefSchema.safeParse(
      latestRound?.base ?? project.baseOverride ?? project.baseBranch,
    );
    const result = await this.commands.send(
      project.runnerId,
      'worktree.status',
      {
        projectId: caller.projectId,
        root: project.rootPath,
        slot: name,
        ...(base.success ? { base: base.data } : {}),
      },
      {
        role: caller.role,
        ctx: caller.ctx,
        ...(this.options.worktreeTimeoutMs
          ? { timeoutMs: this.options.worktreeTimeoutMs }
          : {}),
      },
    );
    if (result.status === 'unknown') {
      throw fleetError(
        504,
        FLEET_ERROR.runnerTimeout,
        'The runner did not answer',
      );
    }
    if (result.status === 'error') {
      throw fleetError(
        409,
        FLEET_ERROR.worktreeUnavailable,
        `${result.error.code}${result.error.message ? `: ${result.error.message}` : ''}`,
      );
    }
    const view: SlotWorktreeView = {
      ...result.output,
      fetchedAt: new Date().toISOString(),
    };
    this.worktrees.set(`${caller.projectId}\0${name}`, {
      view,
      expiresAt: Date.now() + this.options.worktreeCacheMs,
    });
    return view;
  }

  private async latestRun(
    projectId: string,
    name: string,
    withCheckpoints: true,
  ): Promise<Slot & { checkpoints: SlotCheckpoint[] }>;
  private async latestRun(
    projectId: string,
    name: string,
    withCheckpoints: false,
  ): Promise<Slot>;
  private async latestRun(
    projectId: string,
    name: string,
    withCheckpoints: boolean,
  ): Promise<Slot> {
    const row = await this.prisma.slot.findFirst({
      where: { projectId, name },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      ...(withCheckpoints
        ? { include: { checkpoints: { orderBy: { position: 'asc' } } } }
        : {}),
    });
    if (!row) throw slotNotFound();
    return row;
  }
}
