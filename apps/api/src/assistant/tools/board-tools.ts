import {
  ACTION_REQUEST_ISSUE_TITLE_MAX,
  ACTION_REQUEST_SUMMARY_MAX,
  type ActionRequestKind,
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_KINDS,
  BOARD_CARD_TITLE_MAX,
} from '@agentdock/shared';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ActivityQueryService } from '../../activity/activity-query.service';
import { ApprovalsQueryService } from '../../approvals/approvals-query.service';
import { BoardService } from '../../board/board.service';
import { BudgetsService } from '../../budgets/budgets.service';
import { PrismaService } from '../../database/prisma.service';
import { FleetQueryService } from '../../fleet/fleet-query.service';
import { ActionRequestsService } from '../../local/action-requests.service';
import { QueueService } from '../../queue/queue.service';
import { QueueQueryService } from '../../queue/queue-query.service';
import { SessionsQueryService } from '../../sessions/sessions-query.service';
import {
  type AssistantTool,
  type AssistantToolContext,
  AssistantToolError,
  AssistantToolRegistry,
  defineTool,
  type ToolProject,
} from './registry';

const project = z
  .string()
  .max(64)
  .optional()
  .describe(
    "The project's id from list_projects; omit for the conversation's project",
  );
const cardNumber = z
  .number()
  .int()
  .positive()
  .describe('The card number: 12 for C-12');

const draft = z.object({
  project,
  title: z.string().trim().min(1).max(BOARD_CARD_TITLE_MAX),
  body: z.string().max(BOARD_CARD_BODY_MAX).describe('Markdown'),
  kind: z.enum(BOARD_CARD_KINDS).optional(),
});

/** Bytes of a tool's data sent back to the model. */
const DATA_MAX = 16_000;

/** The model gets a bounded JSON of what a service answered. */
export const clipData = (data: unknown): unknown => {
  const text = JSON.stringify(data);
  if (text === undefined || text.length <= DATA_MAX) return data;
  return { truncated: true, json: `${text.slice(0, DATA_MAX)}…` };
};

const where = (p: ToolProject) => p.displayName;

/**
 * ADR-0060 §6: the Board tools. Reads go through the services the web reads
 * with, after the same project check (any member); drafts are returned, not
 * stored; queueing writes a card as Accept of a New work candidate does;
 * stop, merge and handoff only ever create a pending action request.
 */
@Injectable()
export class AssistantBoardTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly prisma: PrismaService,
    private readonly board: BoardService,
    private readonly fleet: FleetQueryService,
    private readonly queueQuery: QueueQueryService,
    private readonly queue: QueueService,
    private readonly budgets: BudgetsService,
    private readonly activity: ActivityQueryService,
    private readonly sessions: SessionsQueryService,
    private readonly approvals: ApprovalsQueryService,
    private readonly requests: ActionRequestsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(...this.tools());
  }

  tools(): AssistantTool[] {
    return [
      defineTool({
        name: 'list_projects',
        label: 'Listing projects',
        description:
          'The projects the person can access, with their role on each.',
        input: z.object({}),
        run: async (_input, ctx) => {
          const rows = await this.prisma.project.findMany({
            where:
              ctx.user.role === 'admin'
                ? {}
                : { members: { some: { userId: ctx.user.id } } },
            select: { id: true, displayName: true, repo: true },
            orderBy: { displayName: 'asc' },
          });
          const projects = await Promise.all(
            rows.map(async (r) => ({
              ...r,
              role: (await ctx.project('read', r.id)).role,
            })),
          );
          return {
            summary: `Listed ${projects.length} projects`,
            data: projects,
          };
        },
      }),
      defineTool({
        name: 'choose_project',
        label: 'Choosing the project',
        description:
          'Records the project the conversation is about, once the person said which one. Use only after the person named or confirmed it.',
        input: z.object({ project: z.string().max(64) }),
        run: async ({ project: id }, ctx) => {
          const p = await ctx.bindProject(id);
          return {
            summary: `Working in ${where(p)}`,
            data: { id: p.id, displayName: p.displayName, role: p.role },
          };
        },
      }),
      defineTool({
        name: 'read_board',
        label: 'Reading the Board',
        description:
          "The project's Board: every column with its cards (number, title, kind, PR and CI state).",
        input: z.object({ project }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const view = await this.board.board(p.id, undefined, p.role);
          const columns = view.columns.map((c) => ({
            column: c.column,
            cards: c.cards.map((card) => ({
              number: card.number,
              label: card.label,
              title: card.title,
              kind: card.kind,
              prNumber: card.prNumber,
              prState: card.prState,
              ciState: card.ciState,
            })),
          }));
          const count = columns.reduce((n, c) => n + c.cards.length, 0);
          return {
            summary: `Read the ${where(p)} Board — ${count} cards`,
            data: clipData({ running: view.running, columns }),
          };
        },
      }),
      defineTool({
        name: 'read_card',
        label: 'Reading a card',
        description: 'One Board card with its body, rounds, PR and checks.',
        input: z.object({ project, card: cardNumber }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const card = await this.board.detail(p.id, input.card, p.role);
          return {
            summary: `Read ${card.label} ${card.title}`,
            data: clipData(card),
          };
        },
      }),
      defineTool({
        name: 'read_fleet',
        label: 'Reading the fleet',
        description:
          "The project's fleet: the orchestrator, its slots and what each works on.",
        input: z.object({ project }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const view = await this.fleet.fleet(p.id);
          return {
            summary: `Read the ${where(p)} fleet`,
            data: clipData(view),
          };
        },
      }),
      defineTool({
        name: 'read_queue',
        label: 'Reading the queue',
        description:
          "The project's issue queue: ready, blocked and running issues.",
        input: z.object({ project }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const view = await this.queueQuery.queue(p.id, {});
          return {
            summary: `Read the ${where(p)} queue`,
            data: clipData(view),
          };
        },
      }),
      defineTool({
        name: 'read_budget',
        label: 'Reading the budget',
        description:
          "What is left of the project's budgets and the person's own, this period.",
        input: z.object({ project }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const remaining = await this.budgets.remaining({
            projectId: p.id,
            userId: ctx.user.id,
          });
          return {
            summary: `Read the ${where(p)} budget — ${remaining.length} budgets`,
            data: clipData(remaining),
          };
        },
      }),
      defineTool({
        name: 'read_activity',
        label: 'Reading activity',
        description: "The project's latest activity, newest first.",
        input: z.object({
          project,
          limit: z.number().int().min(1).max(50).optional(),
        }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const page = await this.activity.project(p.id, {
            limit: input.limit ?? 20,
          });
          return {
            summary: `Read ${where(p)} activity`,
            data: clipData(page),
          };
        },
      }),
      defineTool({
        name: 'read_sessions',
        label: 'Reading sessions',
        description:
          "The project's agent sessions: their slot, model, state and cost. Never their content.",
        input: z.object({
          project,
          limit: z.number().int().min(1).max(50).optional(),
        }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const page = await this.sessions.list(ctx.user, {
            projectId: p.id,
            limit: input.limit ?? 20,
          });
          return {
            summary: `Read ${where(p)} sessions`,
            data: clipData(page),
          };
        },
      }),
      defineTool({
        name: 'read_approvals',
        label: 'Reading approvals',
        description:
          "The project's pull requests waiting for approval, and the action requests waiting for a person.",
        input: z.object({ project }),
        run: async (input, ctx) => {
          const p = await ctx.project('read', input.project);
          const [prs, requests] = await Promise.all([
            this.approvals.list(p.id, 'waiting'),
            this.requests.pending(p.id),
          ]);
          return {
            summary: `Read ${where(p)} approvals — ${requests.length} action requests pending`,
            data: clipData({ pullRequests: prs, actionRequests: requests }),
          };
        },
      }),
      defineTool({
        name: 'draft_card',
        label: 'Drafting a card',
        description:
          'Drafts a Board card for the person to review. Nothing is written: the draft is shown in the chat, and only queue_card puts it on the Board.',
        input: draft,
        run: async (input, ctx) => {
          const p = await ctx.project('write', input.project);
          return {
            summary: `Drafted "${input.title}" for ${where(p)} — not queued yet`,
            data: {
              draft: {
                projectId: p.id,
                title: input.title,
                body: input.body,
                kind: input.kind ?? null,
              },
            },
          };
        },
      }),
      defineTool({
        name: 'queue_card',
        label: 'Queueing a card',
        description:
          "Puts a card on top of the Board's To Do, as accepting a New work draft does. Only when the person asked to queue it.",
        input: draft,
        run: async (input, ctx) => {
          const p = await ctx.project('write', input.project);
          const card = await this.board.create(
            p.id,
            { title: input.title, body: input.body, kind: input.kind },
            { userId: ctx.user.id, role: p.role, ctx: ctx.ctx },
          );
          return {
            summary: `Queued ${card.label} in To Do`,
            data: { number: card.number, label: card.label, column: 'todo' },
          };
        },
      }),
      defineTool({
        name: 'request_action',
        label: 'Requesting an action',
        description:
          "Asks a person to approve an action in Approvals; it never runs here. stop: stop the project's orchestrator. merge: approve a card's pull request for merge. handoff: file a card as an issue for the fleet, queued once approved.",
        input: z.object({
          project,
          action: z.enum(['stop', 'merge', 'handoff']),
          card: cardNumber.optional(),
          pr: z.number().int().positive().optional(),
          reason: z.string().trim().min(1).max(ACTION_REQUEST_SUMMARY_MAX),
        }),
        run: (input, ctx) => this.requestAction(input, ctx),
      }),
    ];
  }

  private async requestAction(
    input: {
      project?: string;
      action: 'stop' | 'merge' | 'handoff';
      card?: number;
      pr?: number;
      reason: string;
    },
    ctx: AssistantToolContext,
  ) {
    const p = await ctx.project('write', input.project);
    const auditor = {
      ctx: ctx.ctx,
      meta: { via: 'assistant', conversationId: ctx.conversationId },
    };
    const request = (kind: ActionRequestKind, args: Record<string, unknown>) =>
      this.requests.create(
        {
          projectId: p.id,
          runnerId: p.runnerId,
          sessionId: null,
          requestedById: ctx.user.id,
          requesterRole: p.role,
          kind,
          args,
          summary: input.reason,
        },
        auditor,
      );
    const card = input.card
      ? await this.board.detail(p.id, input.card, p.role)
      : null;
    let created: Awaited<ReturnType<typeof request>>;
    let what: string;
    if (input.action === 'stop') {
      created = await request('orchestrator_stop', {});
      what = `stopping the ${where(p)} orchestrator`;
    } else if (input.action === 'merge') {
      const pr = input.pr ?? card?.prNumber;
      if (!pr) {
        throw new AssistantToolError(
          'Name the pull request, or a card that has one',
        );
      }
      created = await request('pr_approve', { pr });
      what = `approving PR #${pr}`;
    } else {
      if (!card) throw new AssistantToolError('Name the card to hand off');
      // ADR-0051: filed without the ready label; queued once approved.
      const issue = await this.queue.createIssue(
        { projectId: p.id, role: p.role, ctx: ctx.ctx, meta: auditor.meta },
        {
          title: card.title,
          body: `${card.body}\n\n---\nHanded off from ${card.label} by the AgentDock assistant.`,
          labels: [],
          queue: true,
        },
        { holdForApproval: true },
      );
      created = await request('issue_queue', {
        issue: issue.number,
        title: card.title.slice(0, ACTION_REQUEST_ISSUE_TITLE_MAX),
        url: issue.url,
        session: null,
      });
      what = `queueing issue #${issue.number} (${card.label}) for the fleet`;
    }
    return {
      summary: `Asked to approve ${what} — waiting in Approvals`,
      data: {
        actionRequestId: created.id,
        kind: created.kind,
        status: created.status,
        note: 'Nothing ran. A person approves or denies it in Approvals or Telegram.',
      },
    };
  }
}
