import type { BotCommand } from './telegram-client';

/**
 * #500: the commands the bot answers, in menu order — the one list `/help`
 * prints and `setMyCommands` registers. A Board command added later goes
 * here too. `/start` is left out of the menu: it needs the link code that
 * only AgentDock's link hands out.
 */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'project', description: 'Pick the project for this chat' },
  { command: 'card', description: 'Open a card by its number: /card 12' },
  { command: 'help', description: 'List the commands' },
  { command: 'stop', description: 'Unlink this chat from AgentDock' },
];

/** The `/help` answer. Fixed text: nothing from the chat is echoed back. */
export const HELP_TEXT = [
  'AgentDock bot commands:',
  ...BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`),
  '/project <name> — Switch to a project by its repository name',
  '/start <code> — Link this chat; the link comes from AgentDock → Account → Notifications',
  'Buttons on notifications act on their own project, whatever this chat works on.',
].join('\n');

export const UNKNOWN_COMMAND_TEXT =
  'AgentDock does not know that command. Send /help for the list.';
