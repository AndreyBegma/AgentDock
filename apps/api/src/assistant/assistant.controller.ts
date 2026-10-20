import {
  type AssistantAttachmentView,
  type AssistantConversationView,
  type AssistantMessageView,
  type AssistantModelsView,
  type AssistantStreamEvent,
  ATTACHMENT_UPLOAD_FIELD,
} from '@nautelle/shared';
import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { UploadTooLargeFilter } from '../attachments/attachment-http';
import type { UploadedAttachment } from '../attachments/attachments.service';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import { type AuthUser, getAuth } from '../auth/auth-request';
import { CurrentUser } from '../auth/decorators';
import { AssistantAttachments } from './assistant-attachments.service';
import { AssistantChat } from './assistant-chat.service';
import { AssistantConversations } from './assistant-conversations.service';
import { AssistantModels } from './assistant-models';
import {
  AddAssistantAttachmentDto,
  AssistantStreamDto,
  AttachmentParam,
  ConversationParam,
  CreateAssistantConversationDto,
  UpdateAssistantConversationDto,
} from './dto';

/** Turns one person may start per window: each is one or more model calls. */
export const ASSISTANT_STREAM_LIMIT = 20;
export const ASSISTANT_STREAM_WINDOW_MS = 60_000;

/** Per signed-in user, so people behind one proxy do not share a budget. */
const StreamThrottle = () =>
  applyDecorators(
    Throttle({
      default: {
        limit: ASSISTANT_STREAM_LIMIT,
        ttl: ASSISTANT_STREAM_WINDOW_MS,
        getTracker: (req) => {
          const auth = getAuth(req as Request);
          return auth ? `user:${auth.user.id}` : `ip:${(req as Request).ip}`;
        },
      },
    }),
    UseGuards(ThrottlerGuard),
  );

/** The typed `error` event of a failed turn; never a stack or a key. */
export const streamError = (
  error: unknown,
): Extract<AssistantStreamEvent, { type: 'error' }> => {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null) {
      const {
        error: code,
        message,
        provider,
        resetsAt,
      } = body as Record<string, unknown>;
      if (typeof code === 'string') {
        return {
          type: 'error',
          code: code as Extract<
            AssistantStreamEvent,
            { type: 'error' }
          >['code'],
          message: typeof message === 'string' ? message : error.message,
          ...(typeof provider === 'string'
            ? { provider: provider as never }
            : {}),
          ...(typeof resetsAt === 'string' ? { resetsAt } : {}),
        };
      }
    }
  }
  return {
    type: 'error',
    code: 'assistant_failed',
    message: 'The assistant failed to answer',
  };
};

/**
 * The assistant (ADR-0060). Every route is the signed-in person's own: a
 * conversation of anyone else is 404.
 */
@Controller('assistant')
export class AssistantController {
  private readonly logger = new Logger(AssistantController.name);

  constructor(
    private readonly conversations: AssistantConversations,
    private readonly attachments: AssistantAttachments,
    private readonly chat: AssistantChat,
    private readonly models: AssistantModels,
  ) {}

  @Get('models')
  async listModels(): Promise<AssistantModelsView> {
    return { models: await this.models.options() };
  }

  @Get('conversations')
  list(@CurrentUser() user: AuthUser): Promise<AssistantConversationView[]> {
    return this.conversations.list(user);
  }

  @Post('conversations')
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAssistantConversationDto,
  ): Promise<AssistantConversationView> {
    return this.conversations.create(user, dto);
  }

  @Get('conversations/:id')
  get(
    @CurrentUser() user: AuthUser,
    @Param() { id }: ConversationParam,
  ): Promise<AssistantConversationView> {
    return this.conversations.get(user, id);
  }

  @Patch('conversations/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param() { id }: ConversationParam,
    @Body() dto: UpdateAssistantConversationDto,
  ): Promise<AssistantConversationView> {
    return this.conversations.update(user, id, dto);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param() { id }: ConversationParam,
  ): Promise<void> {
    return this.conversations.remove(user, id);
  }

  @Get('conversations/:id/messages')
  messages(
    @CurrentUser() user: AuthUser,
    @Param() { id }: ConversationParam,
  ): Promise<AssistantMessageView[]> {
    return this.conversations.messages(user, id);
  }

  @Get('conversations/:id/attachments')
  async listAttachments(
    @CurrentUser() user: AuthUser,
    @Param() { id }: ConversationParam,
  ): Promise<AssistantAttachmentView[]> {
    await this.conversations.owned(user, id);
    return this.attachments.list(id);
  }

  @Post('conversations/:id/attachments')
  async attach(
    @CurrentUser() user: AuthUser,
    @Param() { id }: ConversationParam,
    @Body() dto: AddAssistantAttachmentDto,
  ): Promise<AssistantAttachmentView> {
    await this.conversations.owned(user, id);
    return this.attachments.add(user, id, dto);
  }

  /** Multipart field `file`, checked and stored as a Board upload is (ADR-0031). */
  @Post('conversations/:id/attachments/files')
  @UseFilters(UploadTooLargeFilter)
  @UseInterceptors(FileInterceptor(ATTACHMENT_UPLOAD_FIELD))
  async attachFile(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param() { id }: ConversationParam,
    @UploadedFile() file: UploadedAttachment | undefined,
  ): Promise<AssistantAttachmentView> {
    const conversation = await this.conversations.owned(user, id);
    return this.attachments.addFile(user, conversation, file, ctx);
  }

  @Delete('conversations/:id/attachments/:attachmentId')
  @HttpCode(204)
  async detach(
    @CurrentUser() user: AuthUser,
    @Param() { id, attachmentId }: AttachmentParam,
  ): Promise<void> {
    await this.conversations.owned(user, id);
    await this.attachments.remove(id, attachmentId);
  }

  /**
   * One turn as server-sent events, a `data:` line of JSON each: `delta`,
   * `tool`, `project`, `title`, then `done` or a typed `error`. A conversation
   * of anyone else is a plain 404, before the stream opens.
   */
  @Post('conversations/:id/stream')
  @StreamThrottle()
  async stream(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param() { id }: ConversationParam,
    @Body() dto: AssistantStreamDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.conversations.owned(user, id);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: AssistantStreamEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      for await (const event of this.chat.turn({
        user,
        ctx,
        conversationId: id,
        message: dto.message,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        send(event);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const event = streamError(error);
        if (event.code === 'assistant_failed') {
          this.logger.error(
            `assistant turn of ${id} (${req.method} ${req.path}) failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        send(event);
      }
    }
    if (!res.writableEnded) res.end();
  }
}
