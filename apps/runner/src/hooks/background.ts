/**
 * #390: the session's background tasks still running, read from its
 * transcript when a turn stops. A task starts with a tool result that names
 * it — `backgroundTaskId` (Bash `run_in_background`), `taskId` (Monitor) or an
 * `async_launched` `agentId` (Agent) — and ends with a `<task-notification>`
 * that carries a `<status>`. Monitor events are notifications without one.
 *
 * A Claude Code process that starts (`SessionStart:startup` / `:resume`)
 * owns no task an earlier process started, so the last start is a boundary.
 */

export interface BackgroundTask {
  id: string;
  /** The command, or a subagent's description; null when the transcript lacks it. */
  command: string | null;
}

/** The transcript is read only while it is at most this large. */
export const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

const PROCESS_START = /"hookName":"SessionStart:(startup|resume)"/;
const TASK_ID = /<task-id>([^<]+)<\/task-id>/;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const parse = (line: string): Json | null => {
  try {
    return record(JSON.parse(line));
  } catch {
    return null;
  }
};

/** The notification text a transcript line delivers, if it is one. */
const notificationOf = (line: Json): string | null => {
  if (line.type === 'queue-operation') return text(line.content);
  if (line.type === 'user') return text(record(line.message)?.content);
  if (line.type === 'attachment') {
    const attachment = record(line.attachment);
    return attachment?.type === 'queued_command'
      ? text(attachment.prompt)
      : null;
  }
  return null;
};

interface ToolUse {
  name: string;
  command: string | null;
}

/** The id of the background task a tool result started, if it did. */
const startedId = (line: Json, use: ToolUse | undefined): string | null => {
  if (line.type !== 'user') return null;
  const result = record(line.toolUseResult);
  if (!result) return null;
  switch (use?.name) {
    case 'Bash':
      // Also a foreground command moved to the background by its timeout.
      return text(result.backgroundTaskId);
    case 'Monitor':
      return text(result.taskId);
    case 'Agent':
      return result.status === 'async_launched' ? text(result.agentId) : null;
    default:
      return text(result.backgroundTaskId);
  }
};

const toolUseIdOf = (line: Json): string | null => {
  const content = record(line.message)?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const id = text(record(block)?.tool_use_id);
    if (id) return id;
  }
  return null;
};

const BACKGROUND_TOOLS = ['Bash', 'Monitor', 'Agent'];

/** Tool uses that may start a background task, by id. */
const toolUsesOf = (line: Json, into: Map<string, ToolUse>): void => {
  const content = record(line.message)?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const use = record(block);
    if (use?.type !== 'tool_use') continue;
    const id = text(use.id);
    const name = text(use.name);
    if (!id || !name || !BACKGROUND_TOOLS.includes(name)) continue;
    const input = record(use.input);
    into.set(id, {
      name,
      command: text(input?.command) ?? text(input?.description),
    });
  }
};

/** Running background tasks, oldest first. */
export const runningBackgroundTasks = (transcript: string): BackgroundTask[] => {
  const uses = new Map<string, ToolUse>();
  const started = new Map<string, ToolUse | undefined>();
  const done = new Set<string>();
  for (const raw of transcript.split('\n')) {
    if (raw.length === 0) continue;
    if (PROCESS_START.test(raw)) {
      started.clear();
      done.clear();
      continue;
    }
    const maybeUse =
      raw.includes('"tool_use"') &&
      BACKGROUND_TOOLS.some((name) => raw.includes(`"name":"${name}"`));
    const maybeStart =
      raw.includes('"toolUseResult"') &&
      (raw.includes('"backgroundTaskId"') ||
        raw.includes('"taskId"') ||
        raw.includes('"async_launched"'));
    const maybeEnd = raw.includes('<task-notification>');
    if (!maybeUse && !maybeStart && !maybeEnd) continue;
    const line = parse(raw);
    if (!line) continue;
    if (maybeUse && line.type === 'assistant') toolUsesOf(line, uses);
    if (maybeStart) {
      const toolUseId = toolUseIdOf(line);
      const use = toolUseId ? uses.get(toolUseId) : undefined;
      const id = startedId(line, use);
      if (id) started.set(id, use);
    }
    if (maybeEnd) {
      const notification = notificationOf(line);
      if (
        notification?.trimStart().startsWith('<task-notification>') &&
        notification.includes('<status>')
      ) {
        const id = TASK_ID.exec(notification)?.[1];
        if (id) done.add(id);
      }
    }
  }
  const running: BackgroundTask[] = [];
  for (const [id, use] of started) {
    if (!done.has(id)) running.push({ id, command: use?.command ?? null });
  }
  return running;
};

/** A command's first line, its whitespace collapsed, cut to `max` characters. */
export const shortenCommand = (command: string, max: number): string => {
  const line = (command.split('\n').find((l) => l.trim().length > 0) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const more = command.trim().includes('\n') ? '…' : '';
  const whole = `${line}${more}`;
  return whole.length <= max ? whole : `${whole.slice(0, max - 1)}…`;
};
