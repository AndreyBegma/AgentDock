import { randomUUID } from 'node:crypto';
import {
  ACTION_REQUEST_ISSUE_TITLE_MAX,
  ACTION_REQUEST_SUMMARY_MAX,
  issueFromBranch,
} from '@agentdock/shared';
import {
  API_EVENT_SOURCE,
  type LocalMethodArgs,
  type LocalMethodResult,
  MANUAL_HANDOFF_EVENT,
  MANUAL_NOTE_EVENT,
  SESSION_START_CONTEXT_MAX_CHARS,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { BoardService } from '../board/board.service';
import {
  BoardTerminalService,
  NotAManualSession,
} from '../board/board-terminal.service';
import { type BudgetRemaining, BudgetsService } from '../budgets';
import { PrismaService } from '../database/prisma.service';
import type { CreateIssueDto } from '../queue/dto';
import { QueueService } from '../queue/queue.service';
import { RunnerSettingsService } from '../runners/runner-settings.service';
import { recordServerEvent } from '../server-events/server-events';
import { TokenSaverService } from '../token-saver/token-saver.service';
import { ActionRequestsService } from './action-requests.service';
import {
  type LocalCall,
  type LocalHandlerTable,
  type LocalProject,
  projectOf,
} from './local-call';
import { LocalError } from './local-error';

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

const QUEUE_RANK: Record<string, number> = { ready: 0, in_flight: 1 };

const dollars = (value: string): string => `$${Number(value).toFixed(2)}`;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The fixed footer of a handed-off issue (D19). */
export const handoffFooter = (branch: string, sessionId: string | null) =>
  [
    '',
    '---',
    'Handed off to the fleet from a Claude Code session.',
    '',
    `- Source branch: \`${branch}\``,
    `- Session: \`${sessionId ?? 'unknown'}\``,
    '',
    `Continue from branch \`${branch}\` if it exists.`,
  ].join('\n');

const budgetLine = (budgets: BudgetRemaining[]): string => {
  if (budgets.length === 0) return 'Budget: no limits set.';
  const parts = budgets.map(
    (b) =>
      `${b.scope} ${b.period}: ${dollars(b.remainingUsd)} of ${dollars(b.limitUsd)} left${
        b.action === 'stop' ? ' (hard stop)' : ''
      }`,
  );
  return `Budget — ${parts.join('; ')}.`;
};

const TOOLS_LINE =
  'The agentdock MCP tools read the fleet, queue, budget, approvals, activity and sessions; create and queue issues; post notes; hand work off to the fleet; and request actions a person approves.';

/**
 * The handlers of the local method allowlist (spec 201 D7). Reads go to the
 * database directly; writes reuse the domain services, acting as the runner's
 * local user with the router's capped role (D8). The router authorizes, audits
 * and validates each result; a handler only does the work.
 */
@Injectable()
export class LocalHandlers {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: BudgetsService,
    private readonly queue: QueueService,
    private readonly requests: ActionRequestsService,
    private readonly runnerSettings: RunnerSettingsService,
    private readonly board: BoardService,
    private readonly terminal: BoardTerminalService,
    private readonly tokenSaver: TokenSaverService,
  ) {}

  readonly table: LocalHandlerTable = {
    'context.sessionStart': (args, call) => this.sessionStart(args, call),
    'fleet.status': (_args, call) => this.fleetStatus(call),
    'queue.list': (args, call) => this.queueList(args.limit, call),
    'budget.remaining': (_args, call) => this.budgetRemaining(call),
    'approvals.list': (_args, call) => this.approvalsList(call),
    'activity.recent': (args, call) => this.activityRecent(args.limit, call),
    'sessions.recent': (args, call) => this.sessionsRecent(args.limit, call),
    'action.status': (args, call) =>
      this.requests.status(projectOf(call).id, args.id),
    'issue.create': (args, call) => this.issueCreate(args, call),
    'activity.note': (args, call) => this.note(args.text, call),
    'handoff.create': (args, call) => this.handoff(args, call),
    'action.request': (args, call) => this.actionRequest(args, call),
    'away.set': (args, call) => this.awaySet(args.on, call),
    'card.finish': (args, call) =>
      this.cardFinish(args.summary, args.artifactIncomplete === true, call),
    'card.track': (args, call) => this.cardTrack(args, call),
  };

  /**
   * Issue #242 D6: the card worker's `finish_card`. The card is the one whose
   * Claude session asks, in the asking runner's project — never an argument.
   * #282 D2: a person's session that tracks a card finishes that card.
   * #445 D8: a finish the runner's artifact guard accepted incomplete marks
   * the round's run first, while the round is still active.
   */
  private async cardFinish(
    summary: string,
    artifactIncomplete: boolean,
    call: LocalCall,
  ): Promise<LocalMethodResult<'card.finish'>> {
    const project = projectOf(call);
    const session = call.session;
    const target = { id: project.id, runnerId: call.runnerId };
    if (artifactIncomplete && session && session.runtime === 'claude') {
      await this.tokenSaver.markArtifactIncomplete(target, session.id);
    }
    const finished =
      session && session.runtime === 'claude'
        ? ((await this.board.finishByWorker(target, session.id, summary)) ??
          (await this.terminal.finishBySession(target, session.id)))
        : null;
    if (!finished) {
      throw new LocalError('not_a_card_session', 'not a board card session');
    }
    return { number: finished.number, finished: true };
  }

  /**
   * #282 D1: `track_card` — the card of the asking session, created on the
   * first call and updated on every later one. Acts as the local user.
   */
  private async cardTrack(
    args: LocalMethodArgs<'card.track'>,
    call: LocalCall,
  ): Promise<LocalMethodResult<'card.track'>> {
    const project = projectOf(call);
    const session = call.session;
    if (!session || session.runtime !== 'claude') {
      throw new LocalError(
        'not_a_manual_session',
        "not a person's own Claude Code session",
      );
    }
    try {
      return await this.terminal.track(
        { id: project.id, runnerId: call.runnerId },
        session.id,
        args,
        { userId: call.user.id, role: call.role, ctx: call.ctx },
      );
    } catch (error) {
      if (error instanceof NotAManualSession) {
        throw new LocalError(
          'not_a_manual_session',
          "not a person's own Claude Code session",
        );
      }
      throw error;
    }
  }

  /** D16: plain text for the `SessionStart` hook, at most 2 000 characters. */
  private async sessionStart(
    args: LocalMethodArgs<'context.sessionStart'>,
    call: LocalCall,
  ): Promise<LocalMethodResult<'context.sessionStart'>> {
    const project = projectOf(call);
    const issueNumber = issueFromBranch(args.gitBranch);
    const [issue, budgets, liveSlots, ready, prs, requests, runner] =
      await Promise.all([
        issueNumber
          ? this.prisma.issueCache.findUnique({
              where: {
                projectId_number: {
                  projectId: project.id,
                  number: issueNumber,
                },
              },
              select: { title: true, state: true },
            })
          : null,
        this.budgets.remaining({ projectId: project.id, userId: call.user.id }),
        this.prisma.slot.count({
          where: {
            projectId: project.id,
            endedAt: null,
            status: { not: 'ended' },
          },
        }),
        this.prisma.queueStateRow.count({
          where: { projectId: project.id, state: 'ready' },
        }),
        this.prisma.mergeApproval.count({
          where: { projectId: project.id, status: 'waiting' },
        }),
        this.prisma.actionRequest.count({
          where: {
            projectId: project.id,
            status: 'pending',
            expiresAt: { gt: new Date() },
          },
        }),
        this.prisma.runner.findUnique({
          where: { id: call.runnerId },
          select: { awayMode: true },
        }),
      ]);
    const lines = [
      `AgentDock project ${project.displayName} (${project.repo}), base branch ${baseOf(project)}.`,
      ...(issueNumber
        ? [
            issue
              ? `This session's issue: #${issueNumber} ${clip(issue.title, 200)} (${issue.state}).`
              : `This session's branch names issue #${issueNumber}.`,
          ]
        : []),
      budgetLine(budgets),
      `Fleet: ${liveSlots} live slot${liveSlots === 1 ? '' : 's'}, ${ready} ready issue${ready === 1 ? '' : 's'}, ${prs + requests} pending approval${prs + requests === 1 ? '' : 's'}.`,
      runner?.awayMode
        ? 'Away mode is on: permission prompts go to AgentDock for a person to approve.'
        : 'Away mode is off.',
      TOOLS_LINE,
    ];
    return { text: clip(lines.join('\n'), SESSION_START_CONTEXT_MAX_CHARS) };
  }

  private async fleetStatus(
    call: LocalCall,
  ): Promise<LocalMethodResult<'fleet.status'>> {
    const project = projectOf(call);
    const [orchestrator, slots] = await Promise.all([
      this.prisma.fleetOrchestrator.findUnique({
        where: { projectId: project.id },
        select: { status: true },
      }),
      this.prisma.slot.findMany({
        where: {
          projectId: project.id,
          endedAt: null,
          status: { not: 'ended' },
        },
        orderBy: { startedAt: 'asc' },
        take: 50,
        select: { name: true, issue: true, status: true, updatedAt: true },
      }),
    ]);
    const state = orchestrator?.status ?? null;
    return {
      orchestrator: {
        present: state === 'running' || state === 'idle',
        state,
      },
      slots: slots.map((s) => ({
        name: s.name,
        issue: s.issue,
        state: s.status,
        lastActivityAt: s.updatedAt.toISOString(),
      })),
    };
  }

  /** Open issues, ready first, then in flight, then the rest by number. */
  private async queueList(
    limit: number,
    call: LocalCall,
  ): Promise<LocalMethodResult<'queue.list'>> {
    const project = projectOf(call);
    const [issues, states] = await Promise.all([
      this.prisma.issueCache.findMany({
        where: { projectId: project.id, kind: 'issue', state: 'open' },
        select: { number: true, title: true, labels: true },
      }),
      this.prisma.queueStateRow.findMany({
        where: { projectId: project.id },
        select: { issueNumber: true, state: true },
      }),
    ]);
    const stateOf = new Map(states.map((s) => [s.issueNumber, s.state]));
    const rank = (n: number) => QUEUE_RANK[stateOf.get(n) ?? ''] ?? 2;
    const items = issues
      .sort((a, b) => rank(a.number) - rank(b.number) || a.number - b.number)
      .slice(0, limit)
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: strings(i.labels),
        ready: stateOf.get(i.number) === 'ready',
        inFlight: stateOf.get(i.number) === 'in_flight',
      }));
    return { items };
  }

  private async budgetRemaining(
    call: LocalCall,
  ): Promise<LocalMethodResult<'budget.remaining'>> {
    const budgets = await this.budgets.remaining({
      projectId: projectOf(call).id,
      userId: call.user.id,
    });
    return {
      budgets: budgets.map((b) => ({
        scope: b.scope,
        period: b.period,
        action: b.action,
        limitUsd: b.limitUsd,
        spentUsd: b.spentUsd,
        remainingUsd: b.remainingUsd,
        resetsAt: b.resetsAt,
      })),
    };
  }

  private async approvalsList(
    call: LocalCall,
  ): Promise<LocalMethodResult<'approvals.list'>> {
    const project = projectOf(call);
    const waiting = await this.prisma.mergeApproval.findMany({
      where: { projectId: project.id, status: 'waiting' },
      orderBy: { waitingSince: 'asc' },
      take: 50,
      select: { prNumber: true, status: true, slot: true },
    });
    const titles = await this.prisma.issueCache.findMany({
      where: {
        projectId: project.id,
        kind: 'pull_request',
        number: { in: waiting.map((w) => w.prNumber) },
      },
      select: { number: true, title: true },
    });
    const titleOf = new Map(titles.map((t) => [t.number, t.title]));
    return {
      items: waiting.map((w) => ({
        pr: w.prNumber,
        title: titleOf.get(w.prNumber) ?? `PR #${w.prNumber}`,
        status: w.status,
        slot: w.slot,
      })),
      actionRequests: await this.requests.pending(project.id),
    };
  }

  private async activityRecent(
    limit: number,
    call: LocalCall,
  ): Promise<LocalMethodResult<'activity.recent'>> {
    const items = await this.prisma.activityItem.findMany({
      where: { projectId: projectOf(call).id },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { ts: true, type: true, title: true, severity: true },
    });
    return {
      items: items.map((i) => ({
        ts: i.ts.toISOString(),
        type: i.type,
        title: i.title,
        severity: i.severity,
      })),
    };
  }

  private async sessionsRecent(
    limit: number,
    call: LocalCall,
  ): Promise<LocalMethodResult<'sessions.recent'>> {
    const sessions = await this.prisma.agentSession.findMany({
      where: { projectId: projectOf(call).id },
      orderBy: { lastEventAt: 'desc' },
      take: limit,
      select: {
        id: true,
        origin: true,
        title: true,
        gitBranch: true,
        liveState: true,
        lastEventAt: true,
      },
    });
    return {
      items: sessions.map((s) => ({
        ...s,
        lastEventAt: s.lastEventAt.toISOString(),
      })),
    };
  }

  private async issueCreate(
    args: LocalMethodArgs<'issue.create'>,
    call: LocalCall,
  ): Promise<LocalMethodResult<'issue.create'>> {
    return this.fileIssue(
      call,
      {
        title: args.title,
        body: args.body,
        labels: args.labels ?? [],
        queue: args.queue,
      },
      await this.sessionRowId(call),
      'The session asks to queue this issue for the fleet.',
    );
  }

  /**
   * C-112: a session never queues an issue itself. Asked to, it is filed
   * without the ready label, checked as a queued one, with an `issue_queue`
   * request a person approves — text the agent read cannot reach the fleet
   * on its own. The audit row of the create names whom the runner acted for.
   */
  private async fileIssue(
    call: LocalCall,
    dto: CreateIssueDto,
    sessionId: string | null,
    summary: string,
  ): Promise<LocalMethodResult<'issue.create'>> {
    const project = projectOf(call);
    const created = await this.queue.createIssue(
      {
        projectId: project.id,
        role: call.role,
        ctx: call.ctx,
        meta: {
          ...call.meta,
          onBehalfOf: {
            userId: call.user.id,
            runnerId: call.runnerId,
            sessionId: sessionId ?? call.session?.id ?? null,
          },
        },
      },
      dto,
      { holdForApproval: true },
    );
    const result = {
      number: created.number,
      url: created.url,
      queued: created.queued,
    };
    if (!dto.queue) return result;
    const request = await this.requests.create(
      {
        projectId: project.id,
        runnerId: call.runnerId,
        sessionId,
        requestedById: call.user.id,
        requesterRole: call.role,
        kind: 'issue_queue',
        args: {
          issue: created.number,
          title: dto.title.slice(0, ACTION_REQUEST_ISSUE_TITLE_MAX),
          url: created.url,
          session: sessionId,
        },
        summary,
      },
      { ctx: call.ctx, meta: call.meta },
    );
    return {
      ...result,
      queued: false,
      actionRequestId: request.id,
      waiting: `Issue #${created.number} is not queued yet: it waits for a person to approve it in AgentDock (Approvals) or Telegram. Do not queue it another way.`,
    };
  }

  private async note(
    text: string,
    call: LocalCall,
  ): Promise<LocalMethodResult<'activity.note'>> {
    const sessionId = await this.sessionRowId(call);
    await this.serverEvent(call, MANUAL_NOTE_EVENT, {
      text,
      ...(sessionId ? { sessionId } : {}),
    });
    return { recorded: true };
  }

  /**
   * D19: an issue for the fleet, with the fixed footer, and `manual.handoff`.
   * C-112: it is queued only once a person approves its `issue_queue` request.
   */
  private async handoff(
    args: LocalMethodArgs<'handoff.create'>,
    call: LocalCall,
  ): Promise<LocalMethodResult<'handoff.create'>> {
    const sessionId = await this.sessionRowId(call);
    const filed = await this.fileIssue(
      call,
      {
        title: args.title,
        body: `${args.body}\n${handoffFooter(args.branch, sessionId ?? call.session?.id ?? null)}`,
        labels: [],
        queue: true,
      },
      sessionId,
      `The session hands work on branch ${args.branch} off to the fleet.`.slice(
        0,
        ACTION_REQUEST_SUMMARY_MAX,
      ),
    );
    await this.serverEvent(call, MANUAL_HANDOFF_EVENT, {
      issue: filed.number,
      branch: args.branch,
      ...(sessionId ? { sessionId } : {}),
    });
    return filed;
  }

  private async actionRequest(
    args: LocalMethodArgs<'action.request'>,
    call: LocalCall,
  ): Promise<LocalMethodResult<'action.request'>> {
    return this.requests.create(
      {
        projectId: projectOf(call).id,
        runnerId: call.runnerId,
        sessionId: await this.sessionRowId(call),
        requestedById: call.user.id,
        requesterRole: call.role,
        kind: args.kind,
        args: args.args,
        summary: args.summary,
      },
      { ctx: call.ctx, meta: call.meta },
    );
  }

  /** D17: the runner's away mode, set by its local user from the session. */
  private async awaySet(
    on: boolean,
    call: LocalCall,
  ): Promise<LocalMethodResult<'away.set'>> {
    const runner = await this.runnerSettings.update(
      call.runnerId,
      { awayMode: on },
      {
        userId: call.user.id,
        isAdmin: false,
        ctx: call.ctx,
        meta: call.meta,
      },
    );
    return { awayMode: runner.awayMode };
  }

  /** The `sessions` row of the asking session, when it is known yet. */
  private async sessionRowId(call: LocalCall): Promise<string | null> {
    const session = call.session;
    if (
      !session ||
      (session.runtime !== 'claude' && session.runtime !== 'codex')
    ) {
      return null;
    }
    const row = await this.prisma.agentSession.findUnique({
      where: {
        runnerId_runtime_externalId: {
          runnerId: call.runnerId,
          runtime: session.runtime,
          externalId: session.id,
        },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** A `manual.*` server event (ADR-0014), source `api` so no runner can forge it. */
  private async serverEvent(
    call: LocalCall,
    type: string,
    data: Prisma.InputJsonObject,
  ): Promise<void> {
    const project = projectOf(call);
    await this.prisma.$transaction((tx) =>
      recordServerEvent(tx, {
        source: API_EVENT_SOURCE,
        type,
        ts: new Date(),
        project: {
          runnerId: project.runnerId,
          rootPath: project.rootPath,
          repo: project.repo,
        },
        data,
        dedupeKey: `${type}:${randomUUID()}`,
      }),
    );
  }
}

const baseOf = (project: LocalProject): string =>
  project.baseOverride ?? project.baseBranch;
