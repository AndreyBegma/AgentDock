import {
  ASSISTANT_TITLE_MAX,
  type AssistantCardDraft,
  type AssistantStreamEvent,
  type AssistantToolStep,
  type LlmProviderId,
  llmModelSeesImages,
  projectRoleAtLeast,
} from '@agentdock/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditContext } from '../audit/audit.types';
import type { AuthUser } from '../auth/auth-request';
import { PrismaService } from '../database/prisma.service';
import { LlmGateway } from '../llm/llm-gateway.service';
import type {
  LlmContentPart,
  LlmLedger,
  LlmMessage,
  LlmToolCall,
} from '../llm/types';
import { ProjectAccessService } from '../projects/project-access.service';
import { AssistantAttachments } from './assistant-attachments.service';
import { AssistantConversations } from './assistant-conversations.service';
import { ATTACHMENT_INCLUDE, toMessageView } from './assistant-mapper';
import { AssistantModels, type PickedModel } from './assistant-models';
import { BilingualSplitter, type BilingualTrailer } from './bilingual';
import { projectsNamedIn } from './project-resolver';
import {
  type PromptProject,
  SUMMARY_SYSTEM,
  systemPromptParts,
  TITLE_SYSTEM,
} from './prompts';
import {
  type AssistantToolContext,
  AssistantToolError,
  AssistantToolRegistry,
  MIN_ROLE,
  type ToolProject,
} from './tools/registry';

/** Model calls of one turn: tool rounds, then the answer. */
const MAX_CALLS = 8;
/**
 * Earlier messages sent verbatim (ADR-0068 §10); older ones go as the stored
 * summary.
 */
const HISTORY = 20;
/** Most messages one summary refresh folds in. */
const SUMMARY_BATCH = 40;
/** Characters of one message the summary call reads. */
const SUMMARY_MESSAGE_CHARS = 1_500;
const MAX_TOKENS = 4_096;
/** `language` when the model gave no trailer. */
const UNKNOWN_LANGUAGE = 'und';

interface TurnInput {
  user: AuthUser;
  ctx: AuditContext;
  conversationId: string;
  message: string;
  signal?: AbortSignal;
}

const PROJECT_SELECT = {
  id: true,
  displayName: true,
  repo: true,
  runnerId: true,
} as const;

/** How an earlier assistant turn reads to the model: its text and tool steps. */
const historyText = (content: string, steps: unknown): string => {
  const list = Array.isArray(steps) ? (steps as AssistantToolStep[]) : [];
  if (list.length === 0) return content;
  const notes = list.map((s) =>
    s.draft
      ? `- ${s.name}: ${s.summary} ${JSON.stringify(s.draft)}`
      : `- ${s.name}: ${s.summary}`,
  );
  return `${content}\n\n[Tool steps of this reply]\n${notes.join('\n')}`;
};

/**
 * ADR-0060: one turn of a conversation. The person's message is stored, the
 * model streams its reply through the gateway — every call metered and
 * capped there — tools run as the person, and the reply is stored in the
 * person's language with its English text from the same call.
 */
@Injectable()
export class AssistantChat {
  private readonly logger = new Logger(AssistantChat.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: LlmGateway,
    private readonly access: ProjectAccessService,
    private readonly conversations: AssistantConversations,
    private readonly attachments: AssistantAttachments,
    private readonly models: AssistantModels,
    private readonly tools: AssistantToolRegistry,
  ) {}

  async *turn(input: TurnInput): AsyncIterable<AssistantStreamEvent> {
    const { user, message } = input;
    const conversation = await this.conversations.owned(
      user,
      input.conversationId,
    );
    const picked = await this.models.pick(conversation);
    const events: AssistantStreamEvent[] = [];
    const state: { project: ToolProject | null } = { project: null };

    // The bound project, unless access to it was lost: then Auto again.
    if (conversation.projectId) {
      state.project = await this.toolProject(user, conversation.projectId);
      if (!state.project) await this.bind(conversation.id, null);
    }
    let ambiguous: PromptProject[] = [];
    if (!state.project) {
      const visible = await this.prisma.project.findMany({
        where: this.access.visibleWhere(user),
        select: PROJECT_SELECT,
        orderBy: { displayName: 'asc' },
      });
      const named = projectsNamedIn(message, visible);
      const only =
        named.length === 1
          ? named[0]
          : named.length === 0 && visible.length === 1
            ? visible[0]
            : null;
      if (only) {
        state.project = await this.toolProject(user, only.id);
        if (state.project) {
          await this.bind(conversation.id, only.id);
          yield this.projectEvent(state.project);
        }
      } else if (named.length > 1) {
        ambiguous = named;
      }
    }

    const pending = await this.attachments.pending(conversation.id);
    const history = await this.prisma.assistantMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY,
    });
    const userRow = await this.prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
        displayContent: message,
        language: UNKNOWN_LANGUAGE,
      },
    });
    if (pending.length > 0) {
      await this.prisma.assistantAttachment.updateMany({
        where: { id: { in: pending.map((a) => a.id) } },
        data: { messageId: userRow.id },
      });
    }

    let saved = false;
    try {
      const attached = await this.attachments.contentOf(
        user,
        pending,
        llmModelSeesImages(picked.model),
      );
      const latest: LlmContentPart[] = [
        { type: 'text', text: message },
        ...attached,
      ];
      const messages: LlmMessage[] = [
        ...history.reverse().map(
          (m): LlmMessage =>
            m.role === 'user'
              ? { role: 'user', content: m.content }
              : {
                  role: 'assistant',
                  content: historyText(m.content, m.toolResults),
                },
        ),
        { role: 'user', content: attached.length > 0 ? latest : message },
      ];

      const toolCtx = this.toolContext(input, picked.provider, state, events);
      const replies: string[] = [];
      const calls: LlmToolCall[] = [];
      const steps: AssistantToolStep[] = [];
      const callIds: string[] = [];
      let trailer: BilingualTrailer | null = null;

      for (let n = 0; n < MAX_CALLS; n++) {
        const splitter = new BilingualSplitter();
        const ledger: LlmLedger = {};
        const toolCalls: LlmToolCall[] = [];
        const { stable, tail } = systemPromptParts({
          now: new Date(),
          summary: conversation.summary,
          user,
          project: state.project,
          ambiguous: state.project ? [] : ambiguous,
          codeTools: {
            read: this.tools.get('read_file', picked.provider) !== undefined,
            ask:
              this.tools.get('ask_code_agent', picked.provider) !== undefined,
          },
        });
        try {
          for await (const event of this.gateway.stream(
            {
              userId: user.id,
              feature: 'assistant',
              provider: picked.provider,
              request: {
                model: picked.model,
                system: stable,
                systemTail: tail,
                cachePrefix: true,
                messages,
                // The last call answers: no more tool rounds.
                tools:
                  n < MAX_CALLS - 1
                    ? this.tools.definitions(picked.provider)
                    : undefined,
                maxTokens: MAX_TOKENS,
              },
              signal: input.signal,
            },
            ledger,
          )) {
            if (event.type === 'text') {
              const text = splitter.push(event.text);
              if (text) yield { type: 'delta', text };
            } else if (event.type === 'tool_call') {
              toolCalls.push(event.call);
            }
          }
        } finally {
          if (ledger.callId) callIds.push(ledger.callId);
        }
        const rest = splitter.flush();
        if (rest) yield { type: 'delta', text: rest };
        if (splitter.reply) replies.push(splitter.reply);
        trailer = splitter.trailer ?? trailer;
        if (toolCalls.length === 0) break;

        messages.push({
          role: 'assistant',
          content: splitter.reply,
          toolCalls,
        });
        for (const call of toolCalls) {
          yield {
            type: 'tool',
            id: call.id,
            name: call.name,
            status: 'started',
          };
          const { step, content, isError } = await this.runTool(call, toolCtx);
          calls.push(call);
          steps.push(step);
          yield* events.splice(0);
          yield { type: 'tool', status: 'done', ...step };
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content,
            isError,
          });
        }
      }

      const display = replies.join('\n\n');
      const language = trailer?.language ?? UNKNOWN_LANGUAGE;
      const english = trailer?.reply || display;
      await this.prisma.assistantMessage.update({
        where: { id: userRow.id },
        data: { content: trailer?.message || message, language },
      });
      const replyRow = await this.prisma.assistantMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: english,
          displayContent: display,
          language,
          toolCalls:
            calls.length > 0
              ? (calls as unknown as Prisma.InputJsonValue)
              : undefined,
          toolResults:
            steps.length > 0
              ? (steps as unknown as Prisma.InputJsonValue)
              : undefined,
          provider: picked.provider,
          model: picked.model,
          llmCallIds: callIds,
        },
      });
      saved = true;
      await this.prisma.assistantConversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });

      if (!conversation.title) {
        const title = await this.title(user, message, display);
        if (title) {
          await this.prisma.assistantConversation.update({
            where: { id: conversation.id },
            data: { title },
          });
          yield { type: 'title', title };
        }
      }

      await this.refreshSummary(user, conversation);

      const [userView, replyView] = await Promise.all(
        [userRow.id, replyRow.id].map(async (id) =>
          toMessageView(
            await this.prisma.assistantMessage.findUniqueOrThrow({
              where: { id },
              include: { attachments: { include: ATTACHMENT_INCLUDE } },
            }),
          ),
        ),
      );
      yield { type: 'done', userMessage: userView, message: replyView };
    } finally {
      // A turn that failed leaves no half-stored exchange: the message goes,
      // and its attachments are pending again for the retry.
      if (!saved) {
        await this.prisma.assistantMessage.deleteMany({
          where: { id: userRow.id },
        });
      }
    }
  }

  private toolContext(
    input: TurnInput,
    provider: LlmProviderId,
    state: { project: ToolProject | null },
    events: AssistantStreamEvent[],
  ): AssistantToolContext {
    const { user } = input;
    return {
      user,
      ctx: input.ctx,
      conversationId: input.conversationId,
      provider,
      signal: input.signal,
      project: async (need, projectId) => {
        const id = projectId ?? state.project?.id;
        if (!id) {
          throw new AssistantToolError(
            'No project is chosen: ask the person which one, or pass a project id from list_projects',
          );
        }
        const project = await this.toolProject(user, id);
        if (!project) {
          throw new AssistantToolError(
            'The person has no access to that project, or it does not exist',
          );
        }
        if (!projectRoleAtLeast(project.role, MIN_ROLE[need])) {
          throw new AssistantToolError(
            `This needs the ${MIN_ROLE[need]} role on ${project.displayName}; the person is ${project.role}`,
          );
        }
        return project;
      },
      bindProject: async (projectId) => {
        const project = await this.toolProject(user, projectId);
        if (!project) {
          throw new AssistantToolError(
            'The person has no access to that project, or it does not exist',
          );
        }
        await this.bind(input.conversationId, project.id);
        state.project = project;
        events.push(this.projectEvent(project));
        return project;
      },
    };
  }

  private async runTool(
    call: LlmToolCall,
    ctx: AssistantToolContext,
  ): Promise<{ step: AssistantToolStep; content: string; isError: boolean }> {
    const tool = this.tools.get(call.name, ctx.provider);
    const failed = (message: string, code?: string) => ({
      step: { id: call.id, name: call.name, ok: false, summary: message },
      content: JSON.stringify(
        code ? { error: message, code } : { error: message },
      ),
      isError: true,
    });
    if (!tool) return failed(`There is no tool ${call.name}`);
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success)
      return failed(`Invalid input: ${parsed.error.message}`);
    try {
      const result = await tool.run(parsed.data, ctx);
      const draft = (result.data as { draft?: AssistantCardDraft } | null)
        ?.draft;
      return {
        step: {
          id: call.id,
          name: call.name,
          ok: true,
          summary: result.summary,
          ...(draft ? { draft } : {}),
        },
        content: JSON.stringify(result.data ?? null),
        isError: false,
      };
    } catch (error) {
      if (error instanceof AssistantToolError) {
        return failed(error.message, error.code);
      }
      if (error instanceof HttpException) {
        const body = error.getResponse();
        const message =
          typeof body === 'object' && body !== null && 'message' in body
            ? String((body as { message: unknown }).message)
            : error.message;
        return failed(message);
      }
      this.logger.error(
        `assistant tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return failed(`${call.name} failed`);
    }
  }

  /** The project with the person's role on it; null when they cannot see it. */
  private async toolProject(
    user: AuthUser,
    projectId: string,
  ): Promise<ToolProject | null> {
    const access = await this.access.resolve(user, projectId);
    if (!access) return null;
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: PROJECT_SELECT,
    });
    return row ? { ...row, role: access.role } : null;
  }

  private bind(conversationId: string, projectId: string | null) {
    return this.prisma.assistantConversation.update({
      where: { id: conversationId },
      data: { projectId },
    });
  }

  private projectEvent(project: ToolProject): AssistantStreamEvent {
    return {
      type: 'project',
      projectId: project.id,
      projectName: project.displayName,
    };
  }

  /**
   * ADR-0068 §10: the messages that slid out of the verbatim window are folded
   * into the stored summary. Runs only when the window has slid past what the
   * summary covers; the cheapest enabled model, tagged `assistant_summary`;
   * best effort — a failure leaves the old summary and the next turn retries.
   */
  private async refreshSummary(
    user: AuthUser,
    conversation: {
      id: string;
      summary: string | null;
      summaryUpTo: string | null;
    },
  ): Promise<void> {
    try {
      // Everything but the newest HISTORY messages — what the next turn sends
      // as the summary instead of verbatim — newest first.
      const outside = await this.prisma.assistantMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: HISTORY,
        take: SUMMARY_BATCH,
      });
      const newest = outside[0];
      if (!newest || newest.id === conversation.summaryUpTo) return;
      const chronological = outside.reverse();
      const seen = chronological.findIndex(
        (m) => m.id === conversation.summaryUpTo,
      );
      const fresh = chronological.slice(seen + 1);
      const model = await this.models.cheapest();
      if (!model) return;
      const transcript = fresh
        .map(
          (m) =>
            `${m.role === 'user' ? 'Person' : 'Assistant'}: ${historyText(m.content, m.toolResults).slice(0, SUMMARY_MESSAGE_CHARS)}`,
        )
        .join('\n\n');
      const completion = await this.gateway.complete({
        userId: user.id,
        feature: 'assistant_summary',
        provider: model.provider,
        request: {
          model: model.model,
          system: SUMMARY_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Earlier summary:\n${conversation.summary ?? '(none)'}\n\nNew messages:\n${transcript}`,
            },
          ],
          maxTokens: 700,
        },
      });
      const summary = completion.text.trim();
      if (!summary) return;
      await this.prisma.assistantConversation.update({
        where: { id: conversation.id },
        data: { summary, summaryUpTo: newest.id },
      });
    } catch (error) {
      this.logger.warn(
        `conversation summary not refreshed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** ADR-0060 §2: the cheapest enabled model, tagged `title`; best effort. */
  private async title(
    user: AuthUser,
    message: string,
    reply: string,
  ): Promise<string | null> {
    let model: PickedModel | null;
    try {
      model = await this.models.cheapest();
      if (!model) return null;
      const completion = await this.gateway.complete({
        userId: user.id,
        feature: 'title',
        provider: model.provider,
        request: {
          model: model.model,
          system: TITLE_SYSTEM,
          messages: [
            {
              role: 'user',
              content: `Person: ${message.slice(0, 2_000)}\n\nAssistant: ${reply.slice(0, 2_000)}`,
            },
          ],
          maxTokens: 60,
        },
      });
      const title = completion.text
        .split('\n')[0]
        .trim()
        .replace(/^["'«“]+|["'»”.]+$/g, '')
        .trim()
        .slice(0, ASSISTANT_TITLE_MAX);
      return title || null;
    } catch (error) {
      this.logger.warn(
        `conversation title not written: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
