import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What Context handoff reads from a Claude Code session's JSONL transcript
 * (#449 D3, D9, D2): the size of the history a `--resume` re-reads, when its
 * last turn ended, whether it wrote 1-hour cache, the input up to a round's
 * first file edit, and a bounded text excerpt for haiku. Never throws: a
 * transcript that cannot be read answers `null`.
 */

/** A transcript larger than this is not read (the #390 precedent's order of size). */
export const TRANSCRIPT_READ_MAX_BYTES = 64 * 1024 * 1024;

/** The tools whose use is a file edit, for the warm-up (D9). */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/** `<profile>/projects/<encoded cwd>/<sessionId>.jsonl`, wherever the cwd was. */
export const findTranscript = (
  projectsDir: string,
  sessionId: string,
): string | null => {
  const file = `${sessionId}.jsonl`;
  try {
    for (const dir of readdirSync(projectsDir)) {
      const path = join(projectsDir, dir, file);
      if (existsSync(path)) return path;
    }
  } catch {
    return null;
  }
  return null;
};

export const readTranscript = (path: string): string | null => {
  try {
    if (statSync(path).size > TRANSCRIPT_READ_MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

interface Line {
  type: string;
  at: number | null;
  messageId: string | null;
  usage: Usage | null;
  toolNames: string[];
  text: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

const usageOf = (value: unknown): Usage | null => {
  if (!isObject(value)) return null;
  const creation = isObject(value.cache_creation) ? value.cache_creation : null;
  return {
    input: count(value.input_tokens),
    cacheRead: count(value.cache_read_input_tokens),
    cacheWrite: count(value.cache_creation_input_tokens),
    cacheWrite1h: creation ? count(creation.ephemeral_1h_input_tokens) : 0,
  };
};

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isObject(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
};

const parseLine = (raw: string): Line | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.type !== 'string') return null;
  // A subagent's turns are its own context, not the session's history.
  if (value.isSidechain === true) return null;
  const message = isObject(value.message) ? value.message : {};
  const at =
    typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
  const content = message.content;
  const toolNames = Array.isArray(content)
    ? content
        .filter(
          (part): part is { type: 'tool_use'; name: string } =>
            isObject(part) &&
            part.type === 'tool_use' &&
            typeof part.name === 'string',
        )
        .map((part) => part.name)
    : [];
  return {
    type: value.type,
    at: Number.isFinite(at) ? at : null,
    messageId: typeof message.id === 'string' ? message.id : null,
    usage: value.type === 'assistant' ? usageOf(message.usage) : null,
    toolNames,
    text:
      value.type === 'user' || value.type === 'assistant'
        ? textOf(content)
        : '',
  };
};

const linesOf = (jsonl: string): Line[] =>
  jsonl
    .split('\n')
    .filter((raw) => raw.trim().length > 0)
    .map(parseLine)
    .filter((line): line is Line => line !== null);

/** D3: what the restart decision needs of the session. */
export interface TranscriptStats {
  /** The last turn's whole input — the history a `--resume` sends again. */
  historyTokens: number;
  /** When the last assistant turn was written; null without one. */
  lastTurnAt: number | null;
  /** The session wrote 1-hour cache: its cache outlives 5 minutes. */
  cache1h: boolean;
}

export const transcriptStats = (jsonl: string): TranscriptStats => {
  let historyTokens = 0;
  let lastTurnAt: number | null = null;
  let cache1h = false;
  for (const line of linesOf(jsonl)) {
    if (line.type !== 'assistant' || !line.usage) continue;
    const { input, cacheRead, cacheWrite, cacheWrite1h } = line.usage;
    historyTokens = input + cacheRead + cacheWrite;
    if (line.at !== null) lastTurnAt = line.at;
    if (cacheWrite1h > 0) cache1h = true;
  }
  return { historyTokens, lastTurnAt, cache1h };
};

/**
 * D9: the input tokens of the session's turns from `since` up to and
 * including the turn that made the first file edit — each API message once
 * (a message is written as several lines). Without an edit in the transcript
 * yet, every turn since `since`.
 */
export const warmupTokens = (jsonl: string, since: number): number => {
  const seen = new Set<string>();
  let total = 0;
  for (const line of linesOf(jsonl)) {
    if (line.type !== 'assistant' || line.at === null || line.at < since) {
      continue;
    }
    const key = line.messageId;
    if (line.usage && (key === null || !seen.has(key))) {
      if (key !== null) seen.add(key);
      const { input, cacheRead, cacheWrite } = line.usage;
      total += input + cacheRead + cacheWrite;
    }
    if (line.toolNames.some((name) => FILE_EDIT_TOOLS.has(name))) return total;
  }
  return total;
};

/** Characters of transcript text haiku is given at most (D2). */
export const TRANSCRIPT_EXCERPT_MAX_CHARS = 60_000;

/**
 * D2: the conversation's text — prompts and replies, never tool output —
 * newest last, cut from the front to `max` characters.
 */
export const transcriptExcerpt = (
  jsonl: string,
  max = TRANSCRIPT_EXCERPT_MAX_CHARS,
): string => {
  const parts: string[] = [];
  for (const line of linesOf(jsonl)) {
    const text = line.text.trim();
    if (text) parts.push(`[${line.type}] ${text}`);
    if (line.toolNames.length > 0) {
      parts.push(`[${line.type}] (used ${line.toolNames.join(', ')})`);
    }
  }
  const joined = parts.join('\n\n');
  return joined.length > max ? joined.slice(joined.length - max) : joined;
};
