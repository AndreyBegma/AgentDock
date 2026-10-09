import {
  RUN_LOG_LINE_MAX_CHARS,
  type RunLogLine,
} from '@agentdock/shared/protocol';
import { redact } from '../../pane/redact';

/** A tool call is summarised in at most this many characters. */
const TOOL_SUMMARY_MAX = 200;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseLine = (line: string): Json | null => {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Secrets masked (the pane's redactor), then capped. */
const safe = (text: string, max = RUN_LOG_LINE_MAX_CHARS): string =>
  cut(redact(text.split('\n')).join('\n'), max);

const SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
] as const;

/** `Bash: bun test`, `Edit: src/app.ts` — one line per tool call. */
export const toolSummary = (name: string, input: unknown): string => {
  let detail = '';
  if (isObject(input)) {
    for (const key of SUMMARY_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) {
        detail = value.trim().split('\n')[0] ?? '';
        break;
      }
    }
  }
  return safe(detail ? `${name}: ${detail}` : name, TOOL_SUMMARY_MAX);
};

/**
 * One `stream-json` line → the rendered lines of the live log (D13):
 * assistant text, tool calls as one-line summaries, the result, and the
 * session's start as a system line. Everything else renders as nothing.
 */
export const renderStreamLine = (line: string): RunLogLine[] => {
  const message = parseLine(line);
  if (!message) return [];
  switch (message.type) {
    case 'system': {
      if (message.subtype !== 'init') return [];
      const model =
        typeof message.model === 'string' ? ` · ${message.model}` : '';
      return [{ kind: 'system', text: safe(`session started${model}`) }];
    }
    case 'assistant': {
      const content = isObject(message.message)
        ? message.message.content
        : null;
      if (!Array.isArray(content)) return [];
      const lines: RunLogLine[] = [];
      for (const block of content) {
        if (!isObject(block)) continue;
        if (
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim()
        ) {
          lines.push({ kind: 'assistant', text: safe(block.text.trim()) });
        } else if (
          block.type === 'tool_use' &&
          typeof block.name === 'string'
        ) {
          lines.push({
            kind: 'tool',
            text: toolSummary(block.name, block.input),
          });
        }
      }
      return lines;
    }
    case 'result': {
      const text =
        typeof message.result === 'string' && message.result.trim()
          ? message.result.trim()
          : String(message.subtype ?? 'finished');
      return [{ kind: 'result', text: safe(text) }];
    }
    default:
      return [];
  }
};

export interface FinalResult {
  text: string | null;
  isError: boolean;
}

/** D10: the last `result` message of a `stream.jsonl`; null when there is none. */
export const finalResult = (stream: string): FinalResult | null => {
  const lines = stream.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const message = parseLine(lines[i] ?? '');
    if (message?.type !== 'result') continue;
    return {
      text:
        typeof message.result === 'string' && message.result.length > 0
          ? message.result
          : null,
      isError: message.is_error === true || message.subtype !== 'success',
    };
  }
  return null;
};
