import { Injectable } from '@nestjs/common';
import {
  CARD_ACTION_CALLBACK,
  CARD_CONFIRM_CALLBACK,
  CARD_MERGE_CALLBACK,
} from './card-actions';
import { INTAKE_ACTION, INTAKE_DONE, INTAKE_OPTION } from './intake-chat';
import { TelegramActionRequestService } from './telegram-action-request.service';
import { TelegramApprovalService } from './telegram-approval.service';
import { TelegramAssistantService } from './telegram-assistant.service';
import {
  BOARD_CALLBACK_PREFIXES,
  TelegramBoardService,
} from './telegram-board.service';
import { TelegramCardService } from './telegram-card.service';
import { HELP_TEXT, UNKNOWN_COMMAND_TEXT } from './telegram-commands';
import { TelegramIntakeService } from './telegram-intake.service';
import {
  LINK_REPLIES,
  TelegramLinkingService,
} from './telegram-linking.service';
import {
  PROJECT_CALLBACK,
  TelegramProjectService,
} from './telegram-project.service';
import { TelegramRouter } from './telegram-router';
import { TelegramSessionMessageService } from './telegram-session-message.service';

/**
 * #500: every route of the bot in one table, so a Board command plugs in
 * with one line. The order of the reply handlers is the order the poller
 * asked them in before the router existed; a press with a prefix nobody
 * routes still goes to the approvals, which refuse it as an invalid button.
 */
@Injectable()
export class TelegramRoutes {
  readonly router: TelegramRouter;

  constructor(
    linking: TelegramLinkingService,
    approvals: TelegramApprovalService,
    actionRequests: TelegramActionRequestService,
    sessions: TelegramSessionMessageService,
    projects: TelegramProjectService,
    board: TelegramBoardService,
    intake: TelegramIntakeService,
    cards: TelegramCardService,
    assistant: TelegramAssistantService,
  ) {
    this.router = new TelegramRouter()
      // Spec 201 D18: `x:`/`y:` are the action-request buttons.
      .callback(['x', 'y'], (query) => actionRequests.handleCallback(query))
      // #576: the Board's buttons, one prefix per action.
      .callback(BOARD_CALLBACK_PREFIXES, (query) => board.handleCallback(query))
      // #489: `q:` are a card question's option buttons.
      .callback('q', (query) => sessions.handleCallback(query))
      .callback(PROJECT_CALLBACK.prefix, (query) =>
        projects.handleCallback(query),
      )
      // #578: a card's review actions, their confirm step, Accept and merge.
      .callback(
        [
          CARD_ACTION_CALLBACK.prefix,
          CARD_CONFIRM_CALLBACK.prefix,
          CARD_MERGE_CALLBACK.prefix,
        ],
        (query) => cards.handleCallback(query),
      )
      // #574: the `/new` intake's options, Done and its action buttons.
      .callback(
        [INTAKE_OPTION.prefix, INTAKE_DONE.prefix, INTAKE_ACTION.prefix],
        (query) => intake.handleCallback(query),
      )
      // #82: `a:`/`r:` Approve / Request changes.
      .fallbackCallback((query) => approvals.handleCallback(query))
      .reply((message, botId) => approvals.handleNoteReply(message, botId))
      // #489: a reply to a waiting card's message goes to its session.
      .reply((message, botId) => sessions.handleReply(message, botId))
      // #578: a reply to a Feedback or Message session prompt.
      .reply((message, botId) => cards.handleReply(message, botId))
      // #574: an answer to an intake question, or the description `/new` waits for.
      .reply((message, botId) => intake.handleMessage(message, botId))
      .command(['start', 'stop'], async ({ message }) => {
        const reply = await linking.handleMessage(message);
        return (
          reply && { chatId: reply.chatId, text: LINK_REPLIES[reply.reply] }
        );
      })
      .command('project', (context) => projects.handleCommand(context))
      .command('board', (context) => board.handleBoardCommand(context))
      .command('card', (context) => board.handleCardCommand(context))
      .command('new', (context) => intake.handleCommand(context))
      // #620: a new assistant conversation for the chat's free text.
      .command('newchat', (context) => assistant.handleNewChat(context))
      .command('help', async ({ chatId, isPrivate }) =>
        isPrivate ? { chatId, text: HELP_TEXT } : null,
      )
      .unknownCommand(async ({ chatId, isPrivate }) =>
        isPrivate ? { chatId, text: UNKNOWN_COMMAND_TEXT } : null,
      )
      // #620 (ADR-0061): any other text goes to the AI assistant.
      .freeText((message) => assistant.handleMessage(message));
  }
}
