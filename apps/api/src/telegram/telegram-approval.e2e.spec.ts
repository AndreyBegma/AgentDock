import type { PrInspection } from '@nautelle/shared/protocol';
import { ApprovalCommands } from '../approvals';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore } from '../notifications';
import {
  insertEvent,
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { decodeCallback, encodeCallback, notePrompt } from './approval-actions';
import type { InlineKeyboardButton } from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  callbackPress,
  privateMessage,
  replyMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const PR = 51;
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const OPERATOR_CHAT = 5001;
const VIEWER_CHAT = 5002;

const inspection = (
  headSha: string,
  state: PrInspection['state'] = 'open',
): PrInspection => ({
  number: PR,
  url: `https://github.com/acme/widget/pull/${PR}`,
  title: 'feat: widget',
  body: 'Closes #42',
  state,
  headSha,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  files: [],
  filesTruncated: false,
  checks: 'green',
  checkList: [],
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  fetchedAt: '2026-10-12T10:00:00.000Z',
});

const signal = { written: true as const };

describe('Telegram approval buttons (e2e, spec 22 D12, #82)', () => {
  let ctx: TelegramE2e;
  let poller: TelegramPoller;
  let delivery: TelegramDeliveryService;
  let commands: ApprovalCommands;
  let runnerId: string;
  let projectId: string;
  let operatorId: string;
  let viewerId: string;
  let head: string;
  let prState: PrInspection['state'];
  /** The bot's offset outlives a test: update ids only grow. */
  let nextUpdate = 1;

  /** A `pr.awaiting_approval` notification for `userId`, pending on Telegram. */
  const notify = async (userId: string, eventId: bigint) =>
    (
      await ctx.prisma.notification.create({
        data: {
          userId,
          kind: 'pr.awaiting_approval',
          projectId,
          runnerId,
          slot: 'i42-api',
          issue: 42,
          title: `PR #${PR} is waiting for approval`,
          body: 'The orchestrator will merge it once a person approves.',
          link: `/projects/${projectId}/fleet`,
          eventId,
          firstAt: new Date(),
          lastAt: new Date(),
          deliveries: {
            create: {
              userId,
              channel: 'telegram',
              status: 'pending',
              nextAttemptAt: new Date(),
            },
          },
        },
        select: { id: true },
      })
    ).id;

  /** Feeds `updates` through one poll. */
  const poll = async (...updates: { update_id: number }[]) => {
    ctx.fake.updates = updates;
    expect(await poller.pollOnce()).toEqual({
      status: 'polled',
      updates: updates.length,
    });
  };

  const press = (chatId: number, data: string) =>
    poll(callbackPress(nextUpdate++, chatId, data));

  const reply = (
    chatId: number,
    text: string | undefined,
    prompt: string,
    from?: { id: number; is_bot: boolean },
  ) => poll(replyMessage(nextUpdate++, chatId, text, prompt, from));

  /** The buttons of the message sent to `chatId`. */
  const buttonsSentTo = (chatId: number): InlineKeyboardButton[] => {
    const call = ctx.fake
      .sent()
      .find((c) => c.body.chat_id === chatId && c.body.reply_markup);
    const markup = call?.body.reply_markup as
      | { inline_keyboard: InlineKeyboardButton[][] }
      | undefined;
    return markup?.inline_keyboard.flat() ?? [];
  };

  const lastTextTo = (chatId: number) =>
    ctx.fake
      .sent()
      .filter((c) => c.body.chat_id === chatId)
      .at(-1)?.body.text;

  const answers = () =>
    ctx.fake.calls.filter((c) => c.method === 'answerCallbackQuery');

  const telegramAudits = (userId: string) =>
    ctx.prisma.auditRecord.findMany({
      where: { action: 'telegram.approval', actorUserId: userId },
      orderBy: { seq: 'asc' },
      select: { result: true, meta: true, after: true, projectId: true },
    });

  const approvalRow = () =>
    ctx.prisma.mergeApproval.findFirstOrThrow({
      where: { projectId, prNumber: PR },
      orderBy: { createdAt: 'desc' },
    });

  beforeAll(async () => {
    ctx = await createTelegramApp();
    poller = ctx.app.get(TelegramPoller);
    delivery = ctx.app.get(TelegramDeliveryService);
    commands = ctx.app.get(ApprovalCommands);
  });
  afterAll(() => ctx.close());

  let viewerNotificationId: bigint;
  let operatorNotificationId: bigint;
  /** What a viewer's message would have carried had it been offered buttons. */
  const viewerButton = (action: 'approve' | 'request_changes') =>
    encodeCallback({
      action,
      notificationId: viewerNotificationId,
      pr: PR,
      headSha: H1,
    });
  let approveButton: string;
  let changesButton: string;

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    operatorId = (
      await seedUser(ctx.prisma, 'op@example.com', 'operator', projectId)
    ).id;
    viewerId = (
      await seedUser(ctx.prisma, 'view@example.com', 'viewer', projectId)
    ).id;
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', operatorId, { actor: SYSTEM_ACTOR });
    await ctx.prisma.telegramLink.createMany({
      data: [
        { userId: operatorId, chatId: BigInt(OPERATOR_CHAT) },
        { userId: viewerId, chatId: BigInt(VIEWER_CHAT) },
      ],
    });
    await ctx.prisma.mergeApproval.create({
      data: {
        projectId,
        prNumber: PR,
        slot: 'i42-api',
        issue: 42,
        source: 'orchestrator',
        status: 'waiting',
        waitingSince: new Date(),
      },
    });

    head = H1;
    prState = 'open';
    jest
      .spyOn(commands, 'inspect')
      .mockImplementation(async () => inspection(head, prState));
    jest.spyOn(commands, 'approve').mockResolvedValue(signal);
    jest.spyOn(commands, 'requestChanges').mockResolvedValue(signal);
    jest.spyOn(commands, 'voidApproval').mockResolvedValue(signal);

    const eventId = await insertEvent(ctx.prisma, runnerId, {
      type: 'pr.awaiting_approval',
      source: 'code-sentinel',
      data: { pr: PR },
    });
    operatorNotificationId = await notify(operatorId, eventId);
    viewerNotificationId = await notify(viewerId, eventId);
    await delivery.deliverOnce();
    const buttons = buttonsSentTo(OPERATOR_CHAT);
    approveButton = buttons[0]?.callback_data ?? '';
    changesButton = buttons[1]?.callback_data ?? '';
  });
  afterEach(() => jest.restoreAllMocks());

  describe('delivery', () => {
    it('sends Approve and Request changes bound to the head it shows', () => {
      const text = lastTextTo(OPERATOR_CHAT);
      expect(text).toContain('Head `1111111`');
      expect(buttonsSentTo(OPERATOR_CHAT).map((b) => b.text)).toEqual([
        'Approve',
        'Request changes',
      ]);
      expect(decodeCallback(approveButton)).toMatchObject({
        action: 'approve',
        pr: PR,
        headSha: H1,
      });
      // A viewer gets the text without buttons (C-117).
      expect(buttonsSentTo(VIEWER_CHAT)).toHaveLength(0);
      expect(lastTextTo(VIEWER_CHAT)).toContain('waiting for approval');
    });

    it('sends the message without buttons when the runner cannot give the head', async () => {
      await resetTelegram(ctx.prisma);
      ctx.fake.reset();
      ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
      operatorId = (
        await seedUser(ctx.prisma, 'op2@example.com', 'operator', projectId)
      ).id;
      await ctx.app
        .get(BotTokenStore)
        .set(BOT_TOKEN, 'agentdock_bot', operatorId, { actor: SYSTEM_ACTOR });
      await ctx.prisma.telegramLink.create({
        data: { userId: operatorId, chatId: BigInt(OPERATOR_CHAT) },
      });
      jest
        .spyOn(commands, 'inspect')
        .mockRejectedValue(new Error('runner offline'));
      const eventId = await insertEvent(ctx.prisma, runnerId, {
        type: 'pr.awaiting_approval',
        data: { pr: PR },
      });
      await notify(operatorId, eventId);

      expect(await delivery.deliverOnce()).toMatchObject({ sent: 1 });
      const [call] = ctx.fake.sent();
      expect(call.body.reply_markup).toBeUndefined();
      expect(call.body.text).not.toContain('Head');
    });
  });

  describe('Approve', () => {
    it('refuses a viewer with an explanatory reply and a denied audit record', async () => {
      const viewerApprove = viewerButton('approve');
      await press(VIEWER_CHAT, viewerApprove);

      expect(commands.approve).not.toHaveBeenCalled();
      expect(answers()).toHaveLength(1);
      expect(lastTextTo(VIEWER_CHAT)).toBe(
        'Only an operator or an admin of this project can approve or request changes.',
      );
      expect(await telegramAudits(viewerId)).toEqual([
        {
          result: 'denied',
          projectId,
          meta: { reason: 'role', role: 'viewer', via: 'telegram' },
          after: expect.objectContaining({
            pr: PR,
            headSha: H1,
            decision: 'approved',
          }),
        },
      ]);
      expect((await approvalRow()).status).toBe('waiting');
    });

    it('approves an operator’s press through #20 at the head the message showed', async () => {
      await press(OPERATOR_CHAT, approveButton);

      expect(commands.approve).toHaveBeenCalledWith(
        runnerId,
        expect.objectContaining({ pr: PR, headSha: H1, by: 'op@example.com' }),
        expect.objectContaining({ role: 'operator' }),
      );
      expect(lastTextTo(OPERATOR_CHAT)).toBe('Approved PR #51 at 1111111.');
      const row = await approvalRow();
      expect(row).toMatchObject({
        status: 'approved',
        headSha: H1,
        decidedById: operatorId,
      });
      expect(await telegramAudits(operatorId)).toEqual([
        expect.objectContaining({
          result: 'ok',
          meta: { via: 'telegram' },
        }),
      ]);
      // #20 audits the decision itself, as the same user.
      const decision = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'approval.approve', actorUserId: operatorId },
      });
      expect(decision.result).toBe('ok');
    });

    it('refuses a head that moved since the message, as the UI does', async () => {
      head = H2;
      await press(OPERATOR_CHAT, approveButton);

      expect(commands.approve).not.toHaveBeenCalled();
      expect(lastTextTo(OPERATOR_CHAT)).toBe(
        'PR #51 has new commits since this message. Review the new head in Nautelle.',
      );
      expect(await telegramAudits(operatorId)).toEqual([
        expect.objectContaining({
          result: 'denied',
          meta: { reason: 'head_moved', via: 'telegram' },
        }),
      ]);
      expect((await approvalRow()).status).toBe('waiting');
    });

    it('re-checks the role on every press: a demoted operator is refused', async () => {
      await ctx.prisma.projectMember.update({
        where: { projectId_userId: { projectId, userId: operatorId } },
        data: { roleOverride: 'viewer' },
      });
      await press(OPERATOR_CHAT, approveButton);
      expect(commands.approve).not.toHaveBeenCalled();
      expect(await telegramAudits(operatorId)).toEqual([
        expect.objectContaining({
          result: 'denied',
          meta: { reason: 'role', role: 'viewer', via: 'telegram' },
        }),
      ]);
    });

    it('refuses a disabled user and someone no longer a member', async () => {
      await ctx.prisma.user.update({
        where: { id: operatorId },
        data: { status: 'disabled' },
      });
      await press(OPERATOR_CHAT, approveButton);
      await ctx.prisma.user.update({
        where: { id: operatorId },
        data: { status: 'active' },
      });
      await ctx.prisma.projectMember.deleteMany({
        where: { userId: operatorId },
      });
      await press(OPERATOR_CHAT, approveButton);

      expect(commands.approve).not.toHaveBeenCalled();
      expect((await telegramAudits(operatorId)).map((a) => a.meta)).toEqual([
        { reason: 'inactive_user', via: 'telegram' },
        { reason: 'not_member', via: 'telegram' },
      ]);
    });

    it('refuses a press whose PR differs from the notification’s', async () => {
      await press(
        OPERATOR_CHAT,
        encodeCallback({
          action: 'approve',
          notificationId: operatorNotificationId,
          pr: PR + 1,
          headSha: H1,
        }),
      );
      expect(lastTextTo(OPERATOR_CHAT)).toBe(
        'This message is not one Nautelle can act on any more. Decide in Nautelle.',
      );
      expect(commands.approve).not.toHaveBeenCalled();
    });

    it('answers an out-of-range notification id as an invalid button', async () => {
      await press(
        OPERATOR_CHAT,
        `a:9999999999999999999:${PR}:${'A'.repeat(27)}`,
      );
      expect(lastTextTo(OPERATOR_CHAT)).toBe(
        'This button is no longer valid. Decide in Nautelle.',
      );
    });

    it('refuses a press on another user’s message, and from an unlinked chat', async () => {
      // The operator's button, replayed from the viewer's chat.
      await press(VIEWER_CHAT, approveButton);
      expect(lastTextTo(VIEWER_CHAT)).toBe(
        'This message is not one Nautelle can act on any more. Decide in Nautelle.',
      );
      await press(9999, approveButton);
      expect(lastTextTo(9999)).toBe('This chat is not linked to Nautelle.');
      await press(OPERATOR_CHAT, 'a:1:2:not-ours');
      expect(lastTextTo(OPERATOR_CHAT)).toBe(
        'This button is no longer valid. Decide in Nautelle.',
      );

      expect(commands.approve).not.toHaveBeenCalled();
      expect(answers()).toHaveLength(3);
      expect(await telegramAudits(viewerId)).toEqual([
        expect.objectContaining({
          result: 'denied',
          meta: { reason: 'unknown_message', via: 'telegram' },
        }),
      ]);
    });
  });

  describe('Request changes', () => {
    it('asks for the note as a reply, then sends and audits it', async () => {
      await press(OPERATOR_CHAT, changesButton);
      const prompt = ctx.fake.sent().at(-1);
      expect(prompt?.body.reply_markup).toMatchObject({ force_reply: true });
      expect(commands.requestChanges).not.toHaveBeenCalled();

      await reply(
        OPERATOR_CHAT,
        'Split the migration.',
        prompt?.body.text as string,
      );

      expect(commands.requestChanges).toHaveBeenCalledWith(
        runnerId,
        expect.objectContaining({
          pr: PR,
          headSha: H1,
          note: 'Split the migration.',
        }),
        expect.anything(),
      );
      expect(lastTextTo(OPERATOR_CHAT)).toBe(
        'Changes requested on PR #51. The note goes to the worker.',
      );
      expect(await approvalRow()).toMatchObject({
        status: 'changes_requested',
        note: 'Split the migration.',
      });
      expect(await telegramAudits(operatorId)).toEqual([
        expect.objectContaining({
          result: 'ok',
          meta: { via: 'telegram' },
          after: expect.objectContaining({
            decision: 'changes_requested',
            note: 'Split the migration.',
          }),
        }),
      ]);
    });

    it('refuses a reply without a note', async () => {
      const prompt = notePrompt({
        notificationId: decodeCallback(changesButton)?.notificationId ?? 0n,
        pr: PR,
        headSha: H1,
      });
      await reply(OPERATOR_CHAT, undefined, prompt);

      expect(commands.requestChanges).not.toHaveBeenCalled();
      expect(lastTextTo(OPERATOR_CHAT)).toBe(
        'Requesting changes needs a note. Press Request changes again and reply with text.',
      );
      expect(await telegramAudits(operatorId)).toEqual([
        expect.objectContaining({
          result: 'denied',
          meta: { reason: 'note_required', via: 'telegram' },
        }),
      ]);
    });

    it('refuses a viewer’s press before asking for a note, and a viewer’s note', async () => {
      const viewerChanges = viewerButton('request_changes');
      await press(VIEWER_CHAT, viewerChanges);
      expect(ctx.fake.sent().at(-1)?.body.reply_markup).toBeUndefined();

      const prompt = notePrompt({
        notificationId: decodeCallback(viewerChanges)?.notificationId ?? 0n,
        pr: PR,
        headSha: H1,
      });
      await reply(VIEWER_CHAT, 'Please no.', prompt);

      expect(commands.requestChanges).not.toHaveBeenCalled();
      expect((await telegramAudits(viewerId)).map((a) => a.result)).toEqual([
        'denied',
        'denied',
      ]);
    });

    it('ignores a reply to a message the bot did not send, and leaves /start to linking', async () => {
      const prompt = notePrompt({
        notificationId: decodeCallback(changesButton)?.notificationId ?? 0n,
        pr: PR,
        headSha: H1,
      });
      await reply(OPERATOR_CHAT, 'Forged.', prompt, {
        id: OPERATOR_CHAT,
        is_bot: false,
      });
      await poll(privateMessage(nextUpdate++, OPERATOR_CHAT, '/start'));

      expect(commands.requestChanges).not.toHaveBeenCalled();
      expect(await telegramAudits(operatorId)).toEqual([]);
      expect(lastTextTo(OPERATOR_CHAT)).toBe(
        'Open the link from Nautelle → Account → Notifications to connect this chat.',
      );
    });
  });
});
