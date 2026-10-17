import { menuButton } from './mini-app-buttons';
import type { BotCommand, TelegramClient } from './telegram-client';

/**
 * #500: the commands the bot answers, in menu order — the one list `/help`
 * prints and `setMyCommands` registers. A Board command added later goes
 * here too. `/start` is left out of the menu: it needs the link code that
 * only AgentDock's link hands out.
 */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'project', description: 'Pick the project for this chat' },
  { command: 'new', description: 'Start new work: the intake interview' },
  { command: 'help', description: 'List the commands' },
  { command: 'stop', description: 'Unlink this chat from AgentDock' },
];

/** The `/help` answer. Fixed text: nothing from the chat is echoed back. */
export const HELP_TEXT = [
  'AgentDock bot commands:',
  ...BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`),
  '/project <name> — Switch to a project by its repository name',
  '/new <description> — Start new work with the description in one message',
  '/start <code> — Link this chat; the link comes from AgentDock → Account → Notifications',
  'Buttons on notifications act on their own project, whatever this chat works on.',
].join('\n');

export const UNKNOWN_COMMAND_TEXT =
  'AgentDock does not know that command. Send /help for the list.';

/**
 * #500 / #580: what the bot shows beside a private chat's input — the
 * command menu, and the menu button that opens the Mini App (Telegram's
 * default when `APP_URL` is not https). A failure is handed to `warn` and
 * does not stop the other.
 */
export const registerBotMenus = async (
  client: TelegramClient,
  token: string,
  appUrl: string | null,
  warn: (what: 'command menu' | 'menu button', error: unknown) => void,
): Promise<void> => {
  await client
    .setMyCommands(token, [...BOT_COMMANDS])
    .catch((error: unknown) => warn('command menu', error));
  await client
    .setChatMenuButton(token, menuButton(appUrl))
    .catch((error: unknown) => warn('menu button', error));
};
