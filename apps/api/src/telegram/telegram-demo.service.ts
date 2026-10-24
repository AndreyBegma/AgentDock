import { CARD_DEMO_EVENT, cardReviewActions } from '@nautelle/shared';
import { Inject, Injectable } from '@nestjs/common';
import { AttachmentStore } from '../attachments/attachment-store';
import { BoardService } from '../board/board.service';
import { PrismaService } from '../database/prisma.service';
import { demoOutdated } from '../demos/demo-outdated';
import type { DeliveryContent } from '../notifications';
import {
  type DemoFacts,
  demoCaption,
  demoFailedLine,
  demoFitsUpload,
  demoKeyboard,
  demoOverLimitText,
} from './demo-message';
import { appLink } from './markdown-v2';
import { openInAppButton } from './mini-app-buttons';
import { TelegramClient } from './telegram-client';
import { TelegramGuard } from './telegram-guard.service';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const read = async (stream: AsyncIterable<Buffer>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/**
 * What `deliver` did: sent the demo, dropped one that no longer shows the
 * card's PR, or left the plain notification to the caller.
 */
export type DemoDelivery = 'sent' | 'outdated' | 'plain';

/**
 * C-372 (ADR-0096): sends a `card.demo` notification as the demo itself. A
 * ready demo goes as the video — or, over Telegram's 50 MB upload limit for a
 * bot, as a message that sends the person to the card — with the card's PR
 * and CI state and the Merge, Feedback and Open card buttons; a failed demo
 * as one line with its reason. The buttons are #578's card actions, so a
 * press is checked from scratch and Merge asks before it merges, exactly as
 * on the card's own message.
 */
@Injectable()
export class TelegramDemoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: TelegramGuard,
    private readonly board: BoardService,
    private readonly store: AttachmentStore,
    private readonly client: TelegramClient,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  /**
   * Sends notification `notificationId` to `chatId`. `plain` when it is not a
   * demo this service can send — its event, card or video is gone — and the
   * caller sends the plain notification instead; `outdated` when the PR moved
   * on since the demo (another head, or a newer demo), and nothing is sent. `uploaded` maps a demo to
   * the `file_id` Telegram gave its video, so a pass uploads each video once.
   * Telegram's errors are the caller's to handle.
   */
  async deliver(
    token: string,
    chatId: bigint,
    notificationId: bigint,
    content: DeliveryContent,
    uploaded: Map<string, string>,
  ): Promise<DemoDelivery> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { userId: true, projectId: true, eventId: true },
    });
    if (!notification?.projectId || !notification.eventId) return 'plain';
    const { projectId } = notification;
    const event = await this.prisma.event.findUnique({
      where: { id: notification.eventId },
      select: { type: true, data: true },
    });
    const data = record(event?.data);
    const demoId = text(data?.demoId);
    if (event?.type !== CARD_DEMO_EVENT || !data || !demoId) return 'plain';

    const demo = await this.prisma.cardDemo.findUnique({
      where: { id: demoId },
      select: {
        id: true,
        cardId: true,
        headSha: true,
        createdAt: true,
        attachment: {
          select: { id: true, name: true, mime: true, size: true },
        },
        card: {
          select: {
            projectId: true,
            number: true,
            shortId: true,
            ciHeadSha: true,
          },
        },
      },
    });
    if (!demo || demo.card.projectId !== projectId) return 'plain';
    // C-370 may have pushed a newer head while this waited in the queue.
    if (await demoOutdated(this.prisma, demo, demo.card.ciHeadSha)) {
      return 'outdated';
    }

    if (data.status === 'failed') {
      await this.client.sendMessage(
        token,
        chatId,
        demoFailedLine(demo.card.number, text(data.reason)),
        true,
      );
      return 'sent';
    }

    if (!demo.attachment) return 'plain';
    const member = await this.guard.member(
      notification.userId,
      projectId,
      'write',
    );
    if (!member.ok) return 'plain';
    const card = await this.board.detail(
      projectId,
      demo.card.number,
      member.role,
    );
    const open = openInAppButton(
      this.options.appUrl,
      { projectId, card: card.number },
      'Open card',
    );
    const facts: DemoFacts = {
      number: card.number,
      title: card.title,
      projectName: content.projectName,
      prNumber: card.prNumber,
      ciState: card.ciState,
      link: open ? null : appLink(this.options.appUrl, content.link),
    };
    const keyboard = demoKeyboard(
      demo.card.shortId,
      cardReviewActions(card),
      card.prNumber !== null,
      open,
    );
    const markup =
      keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
    const { attachment } = demo;

    if (!demoFitsUpload(attachment.size)) {
      await this.client.sendMessage(
        token,
        chatId,
        demoOverLimitText(facts, attachment.size),
        true,
        markup,
      );
      return 'sent';
    }
    const fileId = uploaded.get(demoId);
    const sent = await this.client.sendVideo(
      token,
      chatId,
      fileId
        ? { fileId }
        : {
            bytes: await read(await this.store.open(projectId, attachment.id)),
            fileName: attachment.name,
            mimeType: attachment.mime,
          },
      demoCaption(facts),
      markup,
    );
    if (sent.fileId) uploaded.set(demoId, sent.fileId);
    return 'sent';
  }
}
