import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramReplyMarkup,
  TelegramUpdate,
} from './telegram-client';

/** What the poller sends back for an update: plain text, maybe with buttons. */
export interface TelegramAnswer {
  chatId: number;
  text: string;
  replyMarkup?: TelegramReplyMarkup;
  /** A press: the callback to answer, with `notice` as its short text. */
  callbackQueryId?: string;
  notice?: string;
}

/** `/cmd args` or `/cmd@Bot args`, split. */
export interface ParsedCommand {
  /** Lower case, without the slash. */
  name: string;
  /** Everything after the command, trimmed; empty when there is nothing. */
  args: string;
}

export interface CommandContext extends ParsedCommand {
  message: TelegramMessage;
  chatId: number;
  /** Telegram's `private` chat type: the only one the bot acts in. */
  isPrivate: boolean;
}

export type CommandHandler = (
  context: CommandContext,
) => Promise<TelegramAnswer | null>;
export type CallbackHandler = (
  query: TelegramCallbackQuery,
) => Promise<TelegramAnswer>;
/** Null: not a reply this handler owns — the next one is asked. */
export type ReplyHandler = (
  message: TelegramMessage,
  botId: number,
) => Promise<TelegramAnswer | null>;

const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/;

/** The command a message's text starts with; null for any other text. */
export const parseCommand = (
  text: string | undefined,
): ParsedCommand | null => {
  const match = text?.trim().match(COMMAND);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
};

/**
 * #500: where an update goes. A button press goes to the handler of its
 * `callback_data` prefix (`<prefix>:…`), else to the fallback; a message
 * goes first to the reply handlers, in the order they were added — a reply
 * to one of the bot's prompts — and then to its command's handler. Any other
 * text, and a command no handler took, gets `unknownCommand` or nothing.
 */
export class TelegramRouter {
  private readonly commands = new Map<string, CommandHandler>();
  private readonly callbacks = new Map<string, CallbackHandler>();
  private readonly replies: ReplyHandler[] = [];
  private fallback: CallbackHandler | null = null;
  private unknown: CommandHandler | null = null;

  command(names: string | string[], handler: CommandHandler): this {
    for (const name of [names].flat()) {
      if (this.commands.has(name)) {
        throw new Error(`command /${name} is routed twice`);
      }
      this.commands.set(name, handler);
    }
    return this;
  }

  callback(prefixes: string | string[], handler: CallbackHandler): this {
    for (const prefix of [prefixes].flat()) {
      if (this.callbacks.has(prefix)) {
        throw new Error(`callback prefix ${prefix} is routed twice`);
      }
      this.callbacks.set(prefix, handler);
    }
    return this;
  }

  /** A press whose prefix no handler took. */
  fallbackCallback(handler: CallbackHandler): this {
    this.fallback = handler;
    return this;
  }

  reply(handler: ReplyHandler): this {
    this.replies.push(handler);
    return this;
  }

  /** A `/command` no handler took. */
  unknownCommand(handler: CommandHandler): this {
    this.unknown = handler;
    return this;
  }

  /** The routed command names, in the order they were added. */
  commandNames(): string[] {
    return [...this.commands.keys()];
  }

  async dispatch(
    update: TelegramUpdate,
    botId: number,
  ): Promise<TelegramAnswer | null> {
    const query = update.callback_query;
    if (query) {
      const data = query.data ?? '';
      const colon = data.indexOf(':');
      const handler =
        (colon > 0 ? this.callbacks.get(data.slice(0, colon)) : undefined) ??
        this.fallback;
      return handler ? handler(query) : null;
    }
    const message = update.message;
    if (!message) return null;
    for (const handler of this.replies) {
      const answer = await handler(message, botId);
      if (answer) return answer;
    }
    const command = parseCommand(message.text);
    if (!command) return null;
    const context: CommandContext = {
      ...command,
      message,
      chatId: message.chat.id,
      isPrivate: message.chat.type === 'private',
    };
    const handler = this.commands.get(command.name) ?? this.unknown;
    return handler ? handler(context) : null;
  }
}
