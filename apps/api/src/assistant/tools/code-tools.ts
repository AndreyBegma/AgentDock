import { randomUUID } from 'node:crypto';
import {
  CODE_ASK_DEFAULT_MODEL,
  CODE_ASK_QUESTION_MAX,
  REPO_SEARCH_RESULTS_MAX,
  type RepoCommandName,
} from '@agentdock/shared/protocol';
import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import type { RunStatus } from '@prisma/client';
import { z } from 'zod';
import { BudgetGate } from '../../budgets/budget-gate';
import { PrismaService } from '../../database/prisma.service';
import { RuntimeProfileResolver } from '../../readiness';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../../runners/runner-command.service';
import { RunnerPresence } from '../../runners/runner-presence';
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
const repoPath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .describe('A path relative to the repository root, e.g. src/app.ts');

/**
 * The typed codes a code tool fails with (#622). The model gets
 * `{ error, code }` and explains it; it never guesses at the code instead.
 */
export const CODE_TOOL_ERROR = {
  /** The project's runner is not connected: code questions need it. */
  runnerOffline: 'runner_offline',
  /** The runner is older than the command, or its config turns it off. */
  runnerUnsupported: 'runner_unsupported',
  /** The runner did not answer within the command's timeout. */
  runnerNoAnswer: 'runner_no_answer',
  /** The runner-local policy refused it (ADR-0047). */
  policyRefused: 'policy_refused',
  /** A path outside the checkout, a secret, or one git ignores. */
  pathNotAllowed: 'path_not_allowed',
  pathNotFound: 'path_not_found',
  /** `ask_code_agent` needs a Claude runtime profile on the project. */
  noClaudeProfile: 'no_claude_profile',
  /** A project or person budget stops new spend. */
  budgetExceeded: 'budget_exceeded',
  runnerError: 'runner_error',
} as const;

/** The runner's own error codes passed on as they are. */
const PASSED_ON = new Set<string>([
  CODE_TOOL_ERROR.policyRefused,
  CODE_TOOL_ERROR.pathNotAllowed,
  CODE_TOOL_ERROR.pathNotFound,
]);

/** `runs.outcome` is short. */
const OUTCOME_MAX = 500;

interface CodeProject extends ToolProject {
  rootPath: string;
  defaultProfileId: string | null;
}

/**
 * #622, ADR-0061: the assistant reads code through the project's runner,
 * never itself (ADR-0001).
 * - `search_code` and `read_file` send `repo.search` and `repo.read`. They
 *   put code in the model's context, so they are offered with Anthropic
 *   models only.
 * - `ask_code_agent` sends `code.ask`: a read-only Claude Code session on
 *   the runner answers, and only its answer reaches the model. It is offered
 *   with every provider.
 *
 * Each needs any member of the project; the runner refuses paths outside
 * the checkout, secrets and what its policy denies. A runner that is offline
 * or does not serve the command is a typed tool error.
 */
@Injectable()
export class AssistantCodeTools implements OnModuleInit {
  constructor(
    private readonly registry: AssistantToolRegistry,
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
    private readonly profiles: RuntimeProfileResolver,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  onModuleInit(): void {
    this.registry.register(...this.tools());
  }

  tools(): AssistantTool[] {
    return [
      defineTool({
        name: 'search_code',
        label: 'Searching the code',
        providers: ['anthropic'],
        description:
          "Searches the project's repository on its runner (git grep over the files git knows) and returns matching lines as path, line and text. A fixed string, case-insensitive, unless regex or caseSensitive. Secret files are never searched. Use it to find where something is defined or used, then read_file to read around a match.",
        input: z.object({
          project,
          query: z.string().min(1).max(200),
          regex: z
            .boolean()
            .optional()
            .describe('An extended regular expression, not a fixed string'),
          caseSensitive: z.boolean().optional(),
          path: repoPath
            .optional()
            .describe('Search only this directory or file'),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(REPO_SEARCH_RESULTS_MAX)
            .optional(),
        }),
        run: async ({ project: id, ...input }, ctx) => {
          const p = await this.codeProject(ctx, id);
          const output = await this.send(p, ctx, 'repo.search', {
            projectId: p.id,
            root: p.rootPath,
            ...input,
          });
          const files = new Set(output.matches.map((m) => m.path)).size;
          return {
            summary: `Searched ${p.displayName} for "${input.query}" — ${output.matches.length}${output.truncated ? '+' : ''} matches in ${files} files`,
            data: output,
          };
        },
      }),
      defineTool({
        name: 'read_file',
        label: 'Reading a file',
        providers: ['anthropic'],
        description:
          "Reads lines of one file of the project's repository on its runner: at most 400 lines per call; `truncated` says there is more. Secret files (.env*, keys) and paths the runner's policy denies are refused.",
        input: z.object({
          project,
          path: repoPath,
          startLine: z.number().int().positive().optional(),
          endLine: z.number().int().positive().optional(),
        }),
        run: async ({ project: id, ...input }, ctx) => {
          const p = await this.codeProject(ctx, id);
          const output = await this.send(p, ctx, 'repo.read', {
            projectId: p.id,
            root: p.rootPath,
            ...input,
          });
          return {
            summary: `Read ${output.path}:${output.startLine}-${output.endLine} of ${output.totalLines} lines`,
            data: output,
          };
        },
      }),
      defineTool({
        name: 'ask_code_agent',
        label: 'Asking the code agent',
        description:
          "Delegates a question about the project's code to a read-only Claude Code session on the project's runner, which reads the repository itself and answers with file references. Slower (up to a few minutes) and it spends the project's budget; use it for questions that need reading many files, or when search_code and read_file are not offered.",
        input: z.object({
          project,
          question: z
            .string()
            .trim()
            .min(1)
            .max(CODE_ASK_QUESTION_MAX)
            .describe(
              'The question, self-contained, in English: the agent sees nothing else of the conversation',
            ),
        }),
        run: async ({ project: id, question }, ctx) => {
          const p = await this.codeProject(ctx, id);
          return this.ask(p, ctx, question);
        },
      }),
    ];
  }

  private async codeProject(
    ctx: AssistantToolContext,
    id: string | undefined,
  ): Promise<CodeProject> {
    const p = await ctx.project('read', id);
    const row = await this.prisma.project.findUniqueOrThrow({
      where: { id: p.id },
      select: { rootPath: true, defaultProfileId: true },
    });
    return { ...p, ...row };
  }

  /** Refuses before sending when the runner is offline or lacks `name`. */
  private ready(p: CodeProject, name: RepoCommandName): void {
    if (!this.presence.isConnected(p.runnerId)) {
      throw new AssistantToolError(
        `The runner of ${p.displayName} is offline. Code questions are answered by the project's runner, so it must be online.`,
        CODE_TOOL_ERROR.runnerOffline,
      );
    }
    const support = this.presence.commandSupport(p.runnerId, name);
    if (support !== 'supported') {
      throw new AssistantToolError(
        support === 'disabled'
          ? `The runner of ${p.displayName} has ${name} turned off in its config.`
          : `The runner of ${p.displayName} is too old to answer code questions (${name}); update it.`,
        CODE_TOOL_ERROR.runnerUnsupported,
      );
    }
  }

  private async send<N extends RepoCommandName>(
    p: CodeProject,
    ctx: AssistantToolContext,
    name: N,
    args: unknown,
    auditArgs?: object,
  ) {
    this.ready(p, name);
    const result: CommandSendResult<N> = await this.commands.send(
      p.runnerId,
      name,
      args,
      { role: p.role, ctx: ctx.ctx, auditArgs },
    );
    if (result.status === 'unknown') {
      throw new AssistantToolError(
        `The runner of ${p.displayName} did not answer ${name}; it may have gone offline.`,
        CODE_TOOL_ERROR.runnerNoAnswer,
      );
    }
    if (result.status === 'error') {
      const { code, message } = result.error;
      throw new AssistantToolError(
        message ?? `${name} failed on the runner (${code})`,
        PASSED_ON.has(code) ? code : CODE_TOOL_ERROR.runnerError,
      );
    }
    return result.output;
  }

  /** `code.ask` as a `code_ask` run, so its spend counts in the budget. */
  private async ask(
    p: CodeProject,
    ctx: AssistantToolContext,
    question: string,
  ) {
    this.ready(p, 'code.ask');
    const pick = await this.profiles.resolve(p);
    if (!pick.ok || pick.profile.runtime !== 'claude') {
      throw new AssistantToolError(
        `${p.displayName} has no Claude runtime profile, which a code agent needs.`,
        CODE_TOOL_ERROR.noClaudeProfile,
      );
    }
    const budget = await this.budgets?.check({
      projectId: p.id,
      userId: ctx.user.id,
    });
    if (budget && !budget.allowed) {
      throw new AssistantToolError(
        `A ${budget.scope} budget stops new spend until ${budget.resetsAt.toISOString()}.`,
        CODE_TOOL_ERROR.budgetExceeded,
      );
    }
    const now = new Date();
    const run = await this.prisma.run.create({
      data: {
        kind: 'code_ask',
        projectId: p.id,
        title: 'Assistant: code question',
        runtime: 'claude',
        model: CODE_ASK_DEFAULT_MODEL,
        profileKey: pick.profile.key,
        args: { conversationId: ctx.conversationId },
        status: 'running',
        triggeredByType: 'user',
        triggeredById: ctx.user.id,
        startedAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    try {
      const output = await this.send(
        p,
        ctx,
        'code.ask',
        {
          projectId: p.id,
          root: p.rootPath,
          runId: run.id,
          sessionId: randomUUID(),
          profileKey: pick.profile.key,
          model: CODE_ASK_DEFAULT_MODEL,
          question,
        },
        // The question is the person's text: its size only in the audit log.
        { projectId: p.id, runId: run.id, questionChars: question.length },
      );
      await this.close(run.id, 'succeeded', 'answered');
      return {
        summary: `The code agent answered on ${p.displayName}'s runner`,
        data: output,
      };
    } catch (error) {
      await this.close(
        run.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async close(
    runId: string,
    status: RunStatus,
    outcome: string,
  ): Promise<void> {
    const now = new Date();
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { startedAt: true },
    });
    await this.prisma.run.updateMany({
      where: { id: runId, endedAt: null },
      data: {
        status,
        endedAt: now,
        durationMs: run ? now.getTime() - run.startedAt.getTime() : 0,
        updatedAt: now,
        outcome: outcome.slice(0, OUTCOME_MAX),
      },
    });
  }
}
