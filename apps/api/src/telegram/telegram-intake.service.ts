import {
  ATTACHMENT_ERROR,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_CARD_MAX,
  type ConfirmSplitRequest,
  PLANNER_ERROR,
  type PlanDetail,
  type PlanIntakeSplitView,
  type PlanQuestion,
  type PlanTurnInput,
  planTurnInputSchema,
  withRecommendations,
} from '@nautelle/shared';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Plan, Prisma, TelegramIntake } from '@prisma/client';
import { z } from 'zod';
import { AttachmentFailure } from '../attachments/attachment-error';
import { AttachmentsService } from '../attachments/attachments.service';
import { userActor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { httpErrorBody } from '../local/local-error';
import { BotTokenStore } from '../notifications';
import { callerOf, type PlanActor, PlanService } from '../planner/plan.service';
import { PlanCardsService } from '../planner/plan-cards.service';
import { PlanStore } from '../planner/plan-store';
import { PlanTurnService } from '../planner/plan-turn.service';
import { plannerError } from '../planner/planner-error';
import {
  type ChatAnswers,
  CLOSED_TEXT,
  candidatesMessage,
  cardsMessage,
  chatAnswers,
  failedMessage,
  INTAKE_ACTION,
  INTAKE_DONE,
  INTAKE_OPTION,
  type IntakeAction,
  type IntakeChatPhase,
  idleMessage,
  intakeChatPhase,
  isIntakeAction,
  phaseKey,
  pressOption,
  questionKeyboard,
  questionText,
  roundControls,
  roundHeader,
  splitMessage,
  THINKING_TEXT,
} from './intake-chat';
import {
  heardText,
  type IntakeMedia,
  intakeMediaOf,
  MEDIA_REPLIES,
  notStoredText,
  VOICE_MAX_BYTES,
} from './intake-media';
import { openCardsKeyboard } from './mini-app-buttons';
import { SpeechToText, SpeechToTextError } from './speech-to-text';
import {
  FileTooLargeError,
  type InlineButton,
  TelegramApiError,
  type TelegramCallbackQuery,
  TelegramClient,
  type TelegramMessage,
} from './telegram-client';
import { TelegramGuard } from './telegram-guard.service';
import { LINK_REPLIES } from './telegram-linking.service';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';
import {
  boardReply,
  projectRefusalText,
  TelegramProjectService,
} from './telegram-project.service';
import {
  type CommandContext,
  parseCommand,
  type TelegramAnswer,
} from './telegram-router';

export const INTAKE_REPLIES = {
  describe:
    'What should the new work do? Send the description as your next message.',
  invalidButton: 'This button is no longer valid. Send /new to start again.',
  over: 'This intake is over. Send /new to start new work.',
  answered: 'Noted as your answer.',
  emptyAnswer: 'Send your answer as text.',
  busy: 'The planner is still thinking. Wait for its answer.',
  failed: 'That did not work. Try again in Nautelle.',
} as const;

/** Why the intake could not start or go on, by the planner's error code. */
const PLANNER_REFUSALS: Partial<Record<string, string>> = {
  [PLANNER_ERROR.commandUnavailable]:
    'The project’s runner is offline, so the planner cannot run and nothing was started. Start the runner, then try again.',
  [PLANNER_ERROR.runnerOutdated]:
    'The runner is too old to plan. Update the runner, then try again.',
  [PLANNER_ERROR.turnInProgress]: INTAKE_REPLIES.busy,
  [PLANNER_ERROR.splitStale]:
    'The proposal changed. Look at the newest one and press again.',
  [PLANNER_ERROR.planClosed]: INTAKE_REPLIES.over,
  [PLANNER_ERROR.noProfile]:
    'The project has no runtime profile for the planner. Pick one in Nautelle.',
  [PLANNER_ERROR.unsupportedRuntime]:
    'The project’s planner profile is not a Claude profile. Pick one in Nautelle.',
  budget_exceeded:
    'A budget stops new runs on this project, so nothing was started.',
};

const refusalOf = (error: unknown): string | null => {
  if (!(error instanceof HttpException)) return null;
  const { code, message } = httpErrorBody(error);
  // #594: a photo the plan could not take — expired, or no room left.
  if (code === ATTACHMENT_ERROR.attachmentError) return notStoredText(message);
  return (code && PLANNER_REFUSALS[code]) ?? INTAKE_REPLIES.failed;
};

/** What a step gives back: its value, or the reply that says why not. */
type Outcome<T> = { ok: true; value: T } | { ok: false; text: string };

const refused = (text: string): { ok: false; text: string } => ({
  ok: false,
  text,
});

const isAnswers = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const answersOf = (row: TelegramIntake): ChatAnswers =>
  isAnswers(row.answers) ? (row.answers as unknown as ChatAnswers) : {};

const questionMessagesOf = (row: TelegramIntake): Record<string, string> =>
  isAnswers(row.questionMessages)
    ? (row.questionMessages as Record<string, string>)
    : {};

type Ready = { row: TelegramIntake & { planId: string }; actor: PlanActor };

/** The force-reply prompt that asks for the description. */
const DESCRIBE_MARKUP = {
  force_reply: true,
  input_field_placeholder: 'What should it do?',
} as const;

/**
 * #574: `/new` runs the New work intake (#337, #409, #480) from a linked
 * chat, through the same planner services the web's routes call — in
 * process, as the linked user, after `TelegramGuard` checked them an
 * operator of the chat's project. One intake per chat (`telegram_intakes`):
 * a round's questions are a message each, with their options as buttons,
 * and a reply to one is its own answer; the round's message sends the
 * answers or says Enough — generate. The plan is the author's private draft,
 * so the web's drafts strip shows it.
 *
 * Turn ends arrive through `PlanStore.watch`, the plan's live event: on each
 * the plan is read again and, when its phase is new, the thinking message is
 * edited into the round, the proposal, the cards or the failure. The phase
 * shown is claimed in the row first, so two events never show it twice.
 *
 * #594: a photo — with `/new` as its caption, before the description, or
 * while the plan is open — is downloaded and stored as the author's upload,
 * then claimed by the plan, like the web dialog's `attachmentIds`. A voice
 * message is transcribed by the configured speech-to-text service and its
 * transcript, shown back first, is the description or the answer.
 */
@Injectable()
export class TelegramIntakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramIntakeService.name);
  /** One refresh at a time per plan; the next waits for the one running. */
  private readonly chains = new Map<string, Promise<void>>();
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: TelegramGuard,
    private readonly projects: TelegramProjectService,
    private readonly plans: PlanService,
    private readonly turns: PlanTurnService,
    private readonly planCards: PlanCardsService,
    private readonly store: PlanStore,
    private readonly tokens: BotTokenStore,
    private readonly client: TelegramClient,
    private readonly attachments: AttachmentsService,
    private readonly speech: SpeechToText,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  onModuleInit(): void {
    this.unwatch = this.store.watch((_projectId, planId) => {
      void this.refresh(planId);
    });
  }

  onModuleDestroy(): void {
    this.unwatch?.();
  }

  /** Every refresh started so far has finished; the e2e suites wait on it. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }

  /** `/new <description>`, or `/new` and the description next. */
  async handleCommand(context: CommandContext): Promise<TelegramAnswer> {
    const { chatId } = context;
    if (!context.isPrivate) return { chatId, text: LINK_REPLIES.notPrivate };
    const current = await this.projects.current(chatId, 'write');
    if (!current.ok) {
      return { chatId, text: projectRefusalText(current.reason) };
    }
    const { project, user } = current;
    await this.reset(user.id, chatId, project.id, []);
    if (!context.args) {
      return {
        chatId,
        text: boardReply(project, INTAKE_REPLIES.describe),
        replyMarkup: DESCRIBE_MARKUP,
      };
    }
    return this.start(chatId, user.id, context.args);
  }

  /** The chat's intake row, fresh: waiting for its description. */
  private async reset(
    userId: string,
    chatId: number,
    projectId: string,
    attachmentIds: string[],
  ): Promise<void> {
    const fresh = {
      chatId: BigInt(chatId),
      projectId,
      planId: null,
      shown: null,
      thinkingMessageId: null,
      controlsMessageId: null,
      questionMessages: {},
      answers: {},
      attachmentIds,
    };
    await this.prisma.telegramIntake.upsert({
      where: { userId },
      create: { userId, ...fresh },
      update: fresh,
    });
  }

  /**
   * A message that is not a command: a reply to one of the open round's
   * question messages is its answer; any text while the chat owes `/new`
   * its description starts the intake. Null for everything else.
   */
  async handleMessage(
    message: TelegramMessage,
    botId: number,
  ): Promise<TelegramAnswer | null> {
    const chatId = message.chat.id;
    if (message.chat.type !== 'private') return null;
    const media = intakeMediaOf(message);
    const command = media ? parseCommand(message.caption) : null;
    if (media && command?.name === 'new') {
      return this.mediaCommand(chatId, media, command.args);
    }
    const userId = await this.guard.linkedUserId(chatId);
    if (!userId) return null;
    const row = await this.prisma.telegramIntake.findUnique({
      where: { userId },
    });
    if (!row || row.chatId !== BigInt(chatId)) return null;
    const prompt = message.reply_to_message;
    const questionId =
      prompt && prompt.from?.id === botId
        ? questionMessagesOf(row)[String(prompt.message_id)]
        : undefined;
    if (media) {
      return this.mediaMessage(message, media, userId, row, questionId);
    }
    if (questionId && row.planId) {
      return this.answerText(chatId, row, questionId, message.text);
    }
    if (row.planId !== null || !message.text?.trim()) return null;
    if (message.text.trim().startsWith('/')) return null;
    return this.start(chatId, userId, message.text.trim(), row.attachmentIds);
  }

  /** #594: a photo or a voice message with `/new` as its caption. */
  private async mediaCommand(
    chatId: number,
    media: IntakeMedia,
    args: string,
  ): Promise<TelegramAnswer> {
    const current = await this.projects.current(chatId, 'write');
    if (!current.ok) {
      return { chatId, text: projectRefusalText(current.reason) };
    }
    const { project, user } = current;
    const reply = (text: string): TelegramAnswer => ({
      chatId,
      text: boardReply(project, text),
    });
    if (media.kind === 'voice') {
      const heard = await this.hear(chatId, media);
      if (!heard.ok) return reply(heard.text);
      await this.reset(user.id, chatId, project.id, []);
      const brief = [args, heard.value].filter(Boolean).join('\n\n');
      return this.start(chatId, user.id, brief);
    }
    const actor = this.actorOf(user.id, project.role);
    const stored = await this.storeImage(project.id, actor, media, 0);
    if (!stored.ok) return reply(stored.text);
    await this.reset(user.id, chatId, project.id, [stored.value]);
    if (!args) {
      return {
        ...reply(MEDIA_REPLIES.photoWaiting),
        replyMarkup: DESCRIBE_MARKUP,
      };
    }
    return this.start(chatId, user.id, args, [stored.value]);
  }

  /**
   * #594: a photo or a voice message to the chat's intake. Before the
   * description, a photo waits on the row for it and a voice message is it;
   * once the plan is open, a photo joins the plan and a voice reply to a
   * question is its answer. Null for a voice message nothing waits for.
   */
  private async mediaMessage(
    message: TelegramMessage,
    media: IntakeMedia,
    userId: string,
    row: TelegramIntake,
    questionId: string | undefined,
  ): Promise<TelegramAnswer | null> {
    const chatId = message.chat.id;
    const caption = message.caption?.trim() ?? '';
    if (row.planId !== null) {
      if (media.kind === 'voice' && !questionId) return null;
      const ready = await this.ready(chatId, row.planId);
      if (!ready.ok) return { chatId, text: ready.text };
      if (media.kind === 'voice' && questionId) {
        const heard = await this.hear(chatId, media);
        if (!heard.ok) return { chatId, text: heard.text };
        return this.answerText(chatId, row, questionId, heard.value);
      }
      return this.addImage(ready, media, questionId, caption);
    }
    const current = await this.projects.current(chatId, 'write');
    if (!current.ok) {
      return { chatId, text: projectRefusalText(current.reason) };
    }
    const { project } = current;
    if (media.kind === 'voice') {
      const heard = await this.hear(chatId, media);
      if (!heard.ok) return { chatId, text: boardReply(project, heard.text) };
      return this.start(chatId, userId, heard.value, row.attachmentIds);
    }
    const stored = await this.storeImage(
      project.id,
      this.actorOf(userId, project.role),
      media,
      row.attachmentIds.length,
    );
    if (!stored.ok) return { chatId, text: boardReply(project, stored.text) };
    const attachmentIds = [...row.attachmentIds, stored.value];
    await this.prisma.telegramIntake.updateMany({
      where: { userId, planId: null },
      data: { attachmentIds },
    });
    if (caption && !caption.startsWith('/')) {
      return this.start(chatId, userId, caption, attachmentIds);
    }
    return {
      chatId,
      text: boardReply(project, MEDIA_REPLIES.photoWaiting),
      replyMarkup: DESCRIBE_MARKUP,
    };
  }

  /** #594: a photo joins the open plan; its caption may answer a question. */
  private async addImage(
    ready: Ready,
    media: IntakeMedia,
    questionId: string | undefined,
    caption: string,
  ): Promise<TelegramAnswer> {
    const { row, actor } = ready;
    const chatId = Number(row.chatId);
    const held = await this.attachments.countOfPlan(row.planId);
    const stored = await this.storeImage(row.projectId, actor, media, held);
    if (!stored.ok) return { chatId, text: stored.text };
    try {
      const plan = await this.store.readable(
        actor.userId,
        row.projectId,
        row.planId,
      );
      await this.plans.attach(plan, actor, [stored.value]);
    } catch (error) {
      const text = refusalOf(error);
      if (text === null) throw error;
      return { chatId, text };
    }
    if (questionId && caption) {
      const answered = await this.answerText(chatId, row, questionId, caption);
      return {
        chatId,
        text: `${MEDIA_REPLIES.photoAdded} ${answered.text ?? ''}`.trim(),
      };
    }
    return { chatId, text: MEDIA_REPLIES.photoAdded };
  }

  private actorOf(userId: string, role: PlanActor['role']): PlanActor {
    return { userId, role, ctx: { actor: userActor(userId) } };
  }

  /**
   * #594: an image downloaded and stored as the author's pending upload —
   * the allowlist, size limit and quota of every upload apply — when the
   * plan, already holding `held`, has room for it. The new attachment's id.
   */
  private async storeImage(
    projectId: string,
    actor: PlanActor,
    media: IntakeMedia,
    held: number,
  ): Promise<Outcome<string>> {
    if (media.kind !== 'image') return refused(MEDIA_REPLIES.notImage);
    if (held + 1 > ATTACHMENTS_PER_CARD_MAX) {
      return refused(MEDIA_REPLIES.tooMany);
    }
    const bytes = await this.download(media, ATTACHMENT_MAX_BYTES);
    if (!bytes.ok) return bytes;
    try {
      const view = await this.attachments.uploadBytes(
        projectId,
        media.name,
        bytes.value,
        actor,
      );
      return { ok: true, value: view.id };
    } catch (error) {
      if (!(error instanceof AttachmentFailure)) throw error;
      return refused(notStoredText(httpErrorBody(error).message));
    }
  }

  /**
   * #594: the transcript of a voice message, shown back to the chat before
   * anything is done with it. The audio is never stored.
   */
  private async hear(
    chatId: number,
    media: Extract<IntakeMedia, { kind: 'voice' }>,
  ): Promise<Outcome<string>> {
    if (!this.speech.enabled) return refused(MEDIA_REPLIES.voiceOff);
    const audio = await this.download(media, VOICE_MAX_BYTES);
    if (!audio.ok) return audio;
    let transcript: string;
    try {
      transcript = await this.speech.transcribe(
        audio.value,
        media.name,
        media.mime,
      );
    } catch (error) {
      if (!(error instanceof SpeechToTextError)) throw error;
      this.logger.warn(`voice message not transcribed: ${error.message}`);
      return refused(MEDIA_REPLIES.transcribeFailed);
    }
    if (!transcript) return refused(MEDIA_REPLIES.notHeard);
    const bot = await this.tokens.read();
    if (bot.ok) {
      await this.client.sendMessage(
        bot.token,
        chatId,
        heardText(transcript),
        true,
      );
    }
    return { ok: true, value: transcript };
  }

  /** #594: a file of the chat, refused past `maxBytes`. */
  private async download(
    media: Exclude<IntakeMedia, { kind: 'other' }>,
    maxBytes: number,
  ): Promise<Outcome<Uint8Array>> {
    const tooLarge =
      media.kind === 'voice'
        ? MEDIA_REPLIES.voiceTooLarge
        : MEDIA_REPLIES.tooLarge;
    if (media.size !== null && media.size > maxBytes) return refused(tooLarge);
    const bot = await this.tokens.read();
    if (!bot.ok) return refused(MEDIA_REPLIES.downloadFailed);
    try {
      const file = await this.client.getFile(bot.token, media.fileId);
      if (file.size !== null && file.size > maxBytes) return refused(tooLarge);
      const bytes = await this.client.downloadFile(
        bot.token,
        file.path,
        maxBytes,
      );
      return { ok: true, value: bytes };
    } catch (error) {
      if (error instanceof FileTooLargeError) return refused(tooLarge);
      if (!(error instanceof TelegramApiError)) throw error;
      // The Bot API serves files up to 20 MB and says so for a bigger one.
      if (/too big/i.test(error.message)) return refused(tooLarge);
      this.logger.warn(`file not downloaded: ${error.message}`);
      return refused(MEDIA_REPLIES.downloadFailed);
    }
  }

  /** A press on an option, Done, or one of the intake's action buttons. */
  async handleCallback(query: TelegramCallbackQuery): Promise<TelegramAnswer> {
    const chat = query.message?.chat;
    const chatId = chat?.id ?? query.from.id;
    const notice = (text: string): TelegramAnswer => ({
      chatId,
      callbackQueryId: query.id,
      notice: text,
    });
    if (chat && chat.type !== 'private') {
      return notice(INTAKE_REPLIES.invalidButton);
    }
    const option = INTAKE_OPTION.decode(query.data);
    const done = INTAKE_DONE.decode(query.data);
    const act = INTAKE_ACTION.decode(query.data);
    const planId = option?.plan ?? done?.plan ?? act?.plan;
    if (!planId) return notice(INTAKE_REPLIES.invalidButton);
    const ready = await this.ready(chatId, planId);
    if (!ready.ok) return notice(ready.text);
    const messageId = query.message?.message_id;
    if (option || done) {
      const questionId =
        messageId !== undefined
          ? questionMessagesOf(ready.row)[String(messageId)]
          : undefined;
      if (!questionId || messageId === undefined) {
        return notice(INTAKE_REPLIES.invalidButton);
      }
      return notice(
        await this.pick(ready, messageId, questionId, option?.option ?? null),
      );
    }
    if (!act || !isIntakeAction(act.action)) {
      return notice(INTAKE_REPLIES.invalidButton);
    }
    if (messageId !== undefined && messageId !== ready.row.controlsMessageId) {
      return notice(INTAKE_REPLIES.invalidButton);
    }
    return notice(await this.act(ready, act.action));
  }

  /** Creates the card plan and shows its first turn. */
  private async start(
    chatId: number,
    userId: string,
    brief: string,
    attachmentIds: readonly string[] = [],
  ): Promise<TelegramAnswer> {
    const current = await this.projects.current(chatId, 'write');
    if (!current.ok) {
      return { chatId, text: projectRefusalText(current.reason) };
    }
    const { project } = current;
    const actor: PlanActor = {
      userId,
      role: project.role,
      ctx: { actor: userActor(userId) },
    };
    let plan: PlanDetail;
    try {
      plan = await this.plans.create(project.id, actor, {
        brief,
        mode: 'card',
        ...(attachmentIds.length > 0
          ? { attachmentIds: [...attachmentIds] }
          : {}),
      });
    } catch (error) {
      const text = refusalOf(error);
      if (text === null) throw error;
      await this.prisma.telegramIntake.deleteMany({
        where: { userId, planId: null },
      });
      return { chatId, text: boardReply(project, text) };
    }
    await this.prisma.telegramIntake.upsert({
      where: { userId },
      create: {
        userId,
        chatId: BigInt(chatId),
        projectId: project.id,
        planId: plan.id,
      },
      update: { projectId: project.id, planId: plan.id, attachmentIds: [] },
    });
    await this.refresh(plan.id);
    return {
      chatId,
      text: boardReply(
        project,
        'New work started. It is in the Board’s drafts too.',
      ),
    };
  }

  /** The chat's intake of `planId`, its user still an operator of it. */
  private async ready(
    chatId: number,
    planId: string,
  ): Promise<({ ok: true } & Ready) | { ok: false; text: string }> {
    const userId = await this.guard.linkedUserId(chatId);
    if (!userId) return { ok: false, text: LINK_REPLIES.notLinked };
    const row = await this.prisma.telegramIntake.findUnique({
      where: { userId },
    });
    if (!row || row.planId !== planId || row.chatId !== BigInt(chatId)) {
      return { ok: false, text: INTAKE_REPLIES.over };
    }
    const check = await this.guard.member(userId, row.projectId, 'write');
    if (!check.ok) return { ok: false, text: projectRefusalText(check.reason) };
    return {
      ok: true,
      row: { ...row, planId },
      actor: { userId, role: check.role, ctx: { actor: userActor(userId) } },
    };
  }

  /** The open round's questions, or null when none is open. */
  private async round(ready: Ready): Promise<PlanQuestion[] | null> {
    const detail = await this.plans.detail(
      ready.row.projectId,
      ready.actor.userId,
      ready.row.planId,
    );
    return intakeChatPhase(detail).kind === 'round' ? detail.questions : null;
  }

  /** An option or Done on a question message: the message shows the picks. */
  private async pick(
    ready: Ready,
    messageId: number,
    questionId: string,
    optionIndex: number | null,
  ): Promise<string> {
    const questions = await this.round(ready);
    const index = questions?.findIndex((q) => q.id === questionId) ?? -1;
    const question = questions?.[index];
    if (!questions || !question) return INTAKE_REPLIES.invalidButton;
    let answers = answersOf(ready.row);
    if (optionIndex !== null) {
      const next = pressOption(answers, question, optionIndex);
      if (!next) return INTAKE_REPLIES.invalidButton;
      answers = next;
      await this.prisma.telegramIntake.update({
        where: { userId: ready.actor.userId },
        data: { answers: answers as Prisma.InputJsonObject },
      });
    }
    const done = optionIndex === null;
    await this.edit(
      ready.row.chatId,
      messageId,
      questionText(
        question,
        { index, total: questions.length },
        answers[question.id],
        done,
      ),
      done
        ? []
        : questionKeyboard(ready.row.planId, question, answers[question.id]),
    );
    return done ? 'Done.' : 'Picked.';
  }

  /** A reply to a question message: the person's own answer to it. */
  private async answerText(
    chatId: number,
    row: TelegramIntake,
    questionId: string,
    text: string | undefined,
  ): Promise<TelegramAnswer> {
    const ready = await this.ready(chatId, row.planId ?? '');
    if (!ready.ok) return { chatId, text: ready.text };
    const answer = text?.trim();
    if (!answer) return { chatId, text: INTAKE_REPLIES.emptyAnswer };
    const questions = await this.round(ready);
    if (!questions?.some((q) => q.id === questionId)) {
      return { chatId, text: INTAKE_REPLIES.over };
    }
    const answers = { ...answersOf(ready.row), [questionId]: { text: answer } };
    await this.prisma.telegramIntake.update({
      where: { userId: ready.actor.userId },
      data: { answers: answers as Prisma.InputJsonObject },
    });
    return { chatId, text: INTAKE_REPLIES.answered };
  }

  /** A round, proposal or failure button, through the planner services. */
  private async act(ready: Ready, action: IntakeAction): Promise<string> {
    const { row, actor } = ready;
    try {
      const plan = await this.store.readable(
        actor.userId,
        row.projectId,
        row.planId,
      );
      const detail = await this.plans.detail(
        row.projectId,
        actor.userId,
        row.planId,
      );
      const phase = intakeChatPhase(detail);
      const caller = callerOf(actor);
      if (action === 'discard') {
        await this.plans.archive(plan, actor);
        await this.refresh(row.planId);
        return 'Discarded.';
      }
      this.store.assertCurrent(plan);
      const notice = await this.run(ready, plan, detail, phase, action, caller);
      if (notice === null) return INTAKE_REPLIES.invalidButton;
      await this.refresh(row.planId);
      return notice;
    } catch (error) {
      const text = refusalOf(error);
      if (text === null) throw error;
      return text;
    }
  }

  private async run(
    ready: Ready,
    plan: Plan,
    detail: PlanDetail,
    phase: IntakeChatPhase,
    action: Exclude<IntakeAction, 'discard'>,
    caller: ReturnType<typeof callerOf>,
  ): Promise<string | null> {
    const turn = (input: PlanTurnInput) =>
      this.turns.planTurn(plan, this.checked(input), caller);
    switch (action) {
      case 'send': {
        if (phase.kind !== 'round') return null;
        const given = chatAnswers(detail.questions, answersOf(ready.row));
        await turn({ answers: withRecommendations(detail.questions, given) });
        return 'Answers sent.';
      }
      case 'generate': {
        if (phase.kind !== 'round' && phase.kind !== 'idle') return null;
        const given =
          phase.kind === 'round'
            ? chatAnswers(detail.questions, answersOf(ready.row))
            : [];
        await turn({
          generate: true,
          ...(given.length > 0 ? { answers: given } : {}),
        });
        return 'Generating.';
      }
      case 'keep_one':
        if (phase.kind !== 'split') return null;
        await turn({ keepOne: true });
        return 'Keeping one card.';
      case 'create_all': {
        if (phase.kind !== 'split') return null;
        await this.planCards.confirmSplit(plan, confirmAll(phase.split));
        return 'Sending the cards to Drafts.';
      }
      case 'retry':
        if (phase.kind !== 'failed') return null;
        await this.turns.retry(plan, phase.turnId, caller);
        return 'Retrying.';
    }
  }

  /** The shared turn schema, as the turn route applies it (`turnInputOf`). */
  private checked(input: PlanTurnInput): PlanTurnInput {
    const parsed = planTurnInputSchema.safeParse(input);
    if (!parsed.success) {
      throw plannerError(
        400,
        PLANNER_ERROR.invalidArgs,
        z.prettifyError(parsed.error),
      );
    }
    return parsed.data;
  }

  /** Shows the plan's phase if the chat has not shown it yet. */
  refresh(planId: string): Promise<void> {
    const previous = this.chains.get(planId) ?? Promise.resolve();
    const next = previous
      .then(() => this.show(planId))
      .catch((error: unknown) => {
        this.logger.warn(
          `intake ${planId} not shown: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.chains.get(planId) === next) this.chains.delete(planId);
      });
    this.chains.set(planId, next);
    return next;
  }

  private async show(planId: string): Promise<void> {
    const row = await this.prisma.telegramIntake.findUnique({
      where: { planId },
    });
    if (!row) return;
    const detail = await this.plans
      .detail(row.projectId, row.userId, planId)
      .catch((error: unknown) => {
        if (error instanceof HttpException && error.getStatus() === 404) {
          return null;
        }
        throw error;
      });
    if (!detail) {
      await this.prisma.telegramIntake.deleteMany({ where: { planId } });
      return;
    }
    const phase = intakeChatPhase(detail);
    const key = phaseKey(phase);
    if (key === row.shown) return;
    const claimed = await this.prisma.telegramIntake.updateMany({
      where: { userId: row.userId, planId, shown: row.shown },
      data: { shown: key },
    });
    if (claimed.count === 0) return;
    const bot = await this.tokens.read();
    if (!bot.ok) return;
    const send = new Sender(this.client, bot.token, row.chatId);
    const appUrl = this.options.appUrl;
    const ids = { planId, projectId: row.projectId };

    switch (phase.kind) {
      case 'thinking': {
        const id = await send.replace(row.thinkingMessageId, THINKING_TEXT);
        await this.save(row, { thinkingMessageId: id });
        return;
      }
      case 'round': {
        await send.replace(
          row.thinkingMessageId,
          roundHeader(phase.round, phase.maxRounds, detail.questions.length),
        );
        const questionMessages: Record<string, string> = {};
        for (const [index, question] of detail.questions.entries()) {
          const id = await send.message(
            questionText(
              question,
              { index, total: detail.questions.length },
              undefined,
            ),
            questionKeyboard(planId, question, undefined),
          );
          if (id !== null) questionMessages[String(id)] = question.id;
        }
        const controls = roundControls(planId);
        const controlsId = await send.message(controls.text, controls.keyboard);
        await this.save(row, {
          thinkingMessageId: null,
          controlsMessageId: controlsId,
          questionMessages,
          answers: {},
        });
        return;
      }
      case 'split':
      case 'failed':
      case 'idle': {
        const message =
          phase.kind === 'split'
            ? splitMessage(phase.split, ids, appUrl)
            : phase.kind === 'failed'
              ? failedMessage(planId)
              : idleMessage(planId);
        const id = await send.replace(
          row.thinkingMessageId,
          message.text,
          message.keyboard,
        );
        await this.save(row, {
          thinkingMessageId: null,
          controlsMessageId: id,
          questionMessages: {},
          answers: {},
        });
        return;
      }
      case 'done': {
        const cards = await this.prisma.boardCard.findMany({
          where: { planId, projectId: row.projectId },
          select: { number: true, title: true, kind: true },
          orderBy: { number: 'asc' },
        });
        // #580: each card opens in the Mini App, besides its link.
        await send.replace(
          row.thinkingMessageId,
          cardsMessage(cards, row.projectId, appUrl),
          openCardsKeyboard(appUrl, row.projectId, cards),
        );
        await this.prisma.telegramIntake.deleteMany({ where: { planId } });
        return;
      }
      case 'review':
        await send.replace(
          row.thinkingMessageId,
          candidatesMessage(phase.candidates, row.projectId, appUrl),
        );
        await this.prisma.telegramIntake.deleteMany({ where: { planId } });
        return;
      case 'closed':
        await send.replace(row.thinkingMessageId, CLOSED_TEXT);
        await this.prisma.telegramIntake.deleteMany({ where: { planId } });
        return;
    }
  }

  private async save(
    row: TelegramIntake,
    data: Prisma.TelegramIntakeUpdateManyMutationInput,
  ): Promise<void> {
    await this.prisma.telegramIntake.updateMany({
      where: { userId: row.userId, planId: row.planId },
      data,
    });
  }

  private async edit(
    chatId: bigint,
    messageId: number,
    text: string,
    keyboard: InlineButton[][],
  ): Promise<void> {
    const bot = await this.tokens.read();
    if (!bot.ok) return;
    await new Sender(this.client, bot.token, chatId)
      .edit(messageId, text, keyboard)
      .catch(() => {});
  }
}

/** Create all: every proposed card as proposed — the stack too, when it is one. */
export const confirmAll = (
  split: PlanIntakeSplitView,
): ConfirmSplitRequest => ({
  turnId: split.turnId,
  cards: split.cards.map((c) => ({
    index: c.index,
    title: c.title,
    kind: c.kind,
  })),
  ...(split.stack
    ? {
        stack: {
          title: split.stack.title,
          body: split.stack.body,
          design: split.stack.design,
          stages: split.stack.stages.map((s) => ({
            title: s.title,
            cards: s.cards,
          })),
        },
      }
    : {}),
});

/** The sends of one refresh, to one chat. */
class Sender {
  constructor(
    private readonly client: TelegramClient,
    private readonly token: string,
    private readonly chatId: bigint,
  ) {}

  message(text: string, keyboard?: InlineButton[][]): Promise<number | null> {
    return this.client.sendMessage(
      this.token,
      this.chatId,
      text,
      false,
      keyboard ? { inline_keyboard: keyboard } : undefined,
    );
  }

  edit(
    messageId: number,
    text: string,
    keyboard?: InlineButton[][],
  ): Promise<void> {
    return this.client.editMessageText(
      this.token,
      this.chatId,
      messageId,
      text,
      false,
      keyboard,
    );
  }

  /**
   * The thinking message edited into `text`, or a new message when there is
   * none or Telegram refuses the edit. The id of the message that shows it.
   */
  async replace(
    thinkingId: number | null,
    text: string,
    keyboard?: InlineButton[][],
  ): Promise<number | null> {
    if (thinkingId !== null) {
      try {
        await this.edit(thinkingId, text, keyboard);
        return thinkingId;
      } catch {
        // Too old, or deleted by the person: a new message instead.
      }
    }
    return this.message(text, keyboard);
  }
}
