import { dirname } from 'node:path';
import { isRunnerMcpServer } from '@nautelle/shared/legacy-names';
import {
  TECHNIQUE_GREP_CUT,
  TECHNIQUE_MCP_CUT,
  TECHNIQUE_WEBFETCH_CUT,
  techniqueOn,
} from './env';
import { RawFile } from './raw-store';
import { type StatsTarget, statsTarget, writeStat } from './stats';

/**
 * #747 D5-D8: `tool-hook`, the PostToolUse hook after the MCP, Grep and
 * WebFetch calls whose cut technique is on (`NAUTELLE_TECHNIQUES`). A result
 * over 16,000 characters becomes its head and tail around a marker that names
 * the full text's raw file.
 *
 * Fail open: any input it does not recognise, and any error, prints nothing,
 * and no output is "no change", so the original result reaches the model.
 *
 * On the hot path like `read-hook`: no imports beyond the filter's own.
 */

export const TOOL_CUT_MAX_CHARS = 16_000;
export const TOOL_CUT_HEAD_CHARS = 6_000;
export const TOOL_CUT_TAIL_CHARS = 2_000;

/** D8: the stats ids. */
export const MCP_CUT_ID = 'tool/mcp-cut';
export const GREP_CUT_ID = 'tool/grep-cut';
export const WEBFETCH_CUT_ID = 'tool/webfetch-cut';

/**
 * The Claude Code version whose `updatedToolOutput` for Grep and WebFetch was
 * recorded (`fixtures/tool-response/`). Older or unknown, those two cuts are
 * off: an object the CLI rejects costs a hook error on every call. The MCP cut
 * uses `updatedMCPToolOutput`, which the plugin has relied on for longer.
 */
export const TOOL_OUTPUT_VERIFIED_CLAUDE: readonly number[] = [2, 1, 306];

export interface ToolHookDeps {
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
  random?: () => number;
}

/**
 * Claude Code names itself in every hook's env: `AI_AGENT` is
 * `claude-code_2-1-306_harness`, and `CLAUDE_CODE_EXECPATH` ends in the
 * version directory. `null` when neither says.
 */
export const claudeCodeVersion = (
  env: Readonly<Record<string, string | undefined>>,
): number[] | null => {
  const found =
    /^claude-code_(\d+)-(\d+)-(\d+)(?:_|$)/.exec(env.AI_AGENT ?? '') ??
    /(?:^|\/)(\d+)\.(\d+)\.(\d+)\/?$/.exec(env.CLAUDE_CODE_EXECPATH ?? '');
  return found ? found.slice(1, 4).map(Number) : null;
};

const toolOutputSupported = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  const version = claudeCodeVersion(env);
  if (!version) return false;
  for (let i = 0; i < TOOL_OUTPUT_VERIFIED_CLAUDE.length; i++) {
    const a = version[i] ?? 0;
    const b = TOOL_OUTPUT_VERIFIED_CLAUDE[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
};

const count = (n: number) => n.toLocaleString('en-US');

export const cutMarker = (
  cut: number,
  total: number,
  unit: 'characters' | 'entries',
  path: string,
): string =>
  `[… Nautelle token saver: ${count(cut)} of ${count(total)} ${unit} cut from the middle. ` +
  `Full output: ${path} — Read it with offset/limit or Grep it for the part you need …]`;

/** `text.slice(start, end)` without splitting a surrogate pair at either end. */
const sliceWhole = (text: string, start: number, end: number): string => {
  const low = (i: number) => {
    const code = text.charCodeAt(i);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  let from = start;
  let to = end;
  if (from > 0 && from < text.length && low(from)) from += 1;
  if (to > 0 && to < text.length && low(to)) to -= 1;
  return text.slice(from, to);
};

/** Saves the full text to a raw file of the run dir; returns its path. */
type Save = (text: string) => string;

/** The head, the marker and the tail of `text`, or `null` when it fits. */
const cutText = (text: string, save: Save): string | null => {
  if (text.length <= TOOL_CUT_MAX_CHARS) return null;
  const head = sliceWhole(text, 0, TOOL_CUT_HEAD_CHARS);
  const tail = sliceWhole(text, text.length - TOOL_CUT_TAIL_CHARS, text.length);
  const cut = text.length - head.length - tail.length;
  const marker = cutMarker(cut, text.length, 'characters', save(text));
  return `${head}\n\n${marker}\n\n${tail}`;
};

/**
 * Grep's `files_with_matches` list: the leading entries that fit the head and
 * the trailing ones that fit the tail, measured as the newline-joined list the
 * model reads, with one marker entry between them.
 */
const cutList = (entries: readonly string[], save: Save): string[] | null => {
  const joined = entries.join('\n');
  if (joined.length <= TOOL_CUT_MAX_CHARS) return null;
  let head = 0;
  for (let size = 0; head < entries.length; head++) {
    size += (entries[head]?.length ?? 0) + 1;
    if (size > TOOL_CUT_HEAD_CHARS) break;
  }
  let tail = 0;
  for (let size = 0; tail < entries.length - head; tail++) {
    size += (entries[entries.length - 1 - tail]?.length ?? 0) + 1;
    if (size > TOOL_CUT_TAIL_CHARS) break;
  }
  const cut = entries.length - head - tail;
  return [
    ...entries.slice(0, head),
    cutMarker(cut, entries.length, 'entries', save(joined)),
    ...entries.slice(entries.length - tail),
  ];
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTextBlock = (block: unknown): block is { type: 'text'; text: string } =>
  isObject(block) && block.type === 'text' && typeof block.text === 'string';

/** The text of an MCP result, whatever shape the hook input carries (plugin `_texts`). */
const mcpText = (response: unknown): string | null => {
  const blocks =
    isObject(response) && Array.isArray(response.content)
      ? response.content
      : response;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) parts.push(block.text);
    else if (typeof block === 'string') parts.push(block);
  }
  return parts.join('\n');
};

/**
 * `summary` in the shape the tool returned: the text blocks become one, the
 * others (images) are kept (plugin `_reshape`).
 */
const mcpReshape = (response: unknown, summary: string): unknown => {
  if (typeof response === 'string') return summary;
  if (isObject(response) && Array.isArray(response.content)) {
    return { ...response, content: mcpReshape(response.content, summary) };
  }
  const others = (response as unknown[]).filter(
    (block) =>
      typeof block !== 'string' && !(isObject(block) && block.type === 'text'),
  );
  return [{ type: 'text', text: summary }, ...others];
};

/**
 * D7: the runner's own server, by its name in a launch (`nautelle`) or as the
 * plugin's (`plugin_nautelle_nautelle`), is never cut.
 */
const runnerServer = (data: Json, tool: string): boolean => {
  const names = [/^mcp__(.+?)__/.exec(tool)?.[1]];
  if (isObject(data.mcp_server) && typeof data.mcp_server.name === 'string') {
    names.push(data.mcp_server.name);
  }
  return names.some(
    (name) =>
      name !== undefined &&
      (isRunnerMcpServer(name) ||
        (name.startsWith('plugin') &&
          isRunnerMcpServer(name.split(/[_:]/).pop() ?? ''))),
  );
};

interface Cut {
  filter: string;
  rawBytes: number;
  keptBytes: number;
  output: Json;
}

const bytes = (text: string) => Buffer.byteLength(text);

const mcpCut = (data: Json, save: Save): Cut | null => {
  const response = data.tool_response;
  const text = mcpText(response);
  if (!text) return null;
  const summary = cutText(text, save);
  if (summary === null) return null;
  return {
    filter: MCP_CUT_ID,
    rawBytes: bytes(text),
    keptBytes: bytes(summary),
    output: { updatedMCPToolOutput: mcpReshape(response, summary) },
  };
};

/** `updatedToolOutput`: the tool's own object with one field cut (D6). */
const fieldCut = (
  filter: string,
  response: Json,
  field: string,
  full: string,
  kept: string,
  value: unknown,
): Cut => ({
  filter,
  rawBytes: bytes(full),
  keptBytes: bytes(kept),
  output: { updatedToolOutput: { ...response, [field]: value } },
});

/** The Grep shapes recorded from Claude Code (`fixtures/tool-response/grep-*`). */
const grepCut = (data: Json, save: Save): Cut | null => {
  const response = data.tool_response;
  if (!isObject(response)) return null;
  if (
    (response.mode === 'content' || response.mode === 'count') &&
    typeof response.content === 'string'
  ) {
    const kept = cutText(response.content, save);
    if (kept === null) return null;
    return fieldCut(
      GREP_CUT_ID,
      response,
      'content',
      response.content,
      kept,
      kept,
    );
  }
  const names = response.filenames;
  if (
    response.mode === 'files_with_matches' &&
    Array.isArray(names) &&
    names.every((name) => typeof name === 'string')
  ) {
    const kept = cutList(names, save);
    if (kept === null) return null;
    return fieldCut(
      GREP_CUT_ID,
      response,
      'filenames',
      names.join('\n'),
      kept.join('\n'),
      kept,
    );
  }
  return null;
};

/** The WebFetch shape recorded from Claude Code (`fixtures/tool-response/webfetch.json`). */
const webFetchCut = (data: Json, save: Save): Cut | null => {
  const response = data.tool_response;
  if (
    !isObject(response) ||
    typeof response.result !== 'string' ||
    typeof response.url !== 'string'
  ) {
    return null;
  }
  const kept = cutText(response.result, save);
  if (kept === null) return null;
  return fieldCut(
    WEBFETCH_CUT_ID,
    response,
    'result',
    response.result,
    kept,
    kept,
  );
};

const cutFor = (
  data: Json,
  env: ToolHookDeps['env'],
  save: Save,
): Cut | null => {
  const tool = data.tool_name;
  if (typeof tool !== 'string') return null;
  if (tool.startsWith('mcp__')) {
    if (!techniqueOn(env, TECHNIQUE_MCP_CUT) || runnerServer(data, tool)) {
      return null;
    }
    return mcpCut(data, save);
  }
  if (tool === 'Grep') {
    if (!techniqueOn(env, TECHNIQUE_GREP_CUT) || !toolOutputSupported(env)) {
      return null;
    }
    return grepCut(data, save);
  }
  if (tool === 'WebFetch') {
    if (
      !techniqueOn(env, TECHNIQUE_WEBFETCH_CUT) ||
      !toolOutputSupported(env)
    ) {
      return null;
    }
    return webFetchCut(data, save);
  }
  return null;
};

/** The full text in `<run dir>/raw/<n>.log` (D5); throws when it cannot be saved. */
const saveTo =
  (target: StatsTarget): Save =>
  (text) => {
    const raw = RawFile.create(dirname(target.file));
    try {
      raw.write(Buffer.from(text));
    } finally {
      raw.close();
    }
    return raw.path;
  };

/** The hook's stdout for one PostToolUse event; `''` leaves the result as it is. */
export const runToolHook = (stdin: string, deps: ToolHookDeps): string => {
  try {
    const target = statsTarget(deps.env);
    // Without the launch's env, Token saver is not on for this session.
    if (!target) return '';
    const data: unknown = JSON.parse(stdin);
    if (!isObject(data) || data.hook_event_name !== 'PostToolUse') return '';
    const cut = cutFor(data, deps.env, saveTo(target));
    if (!cut) return '';
    writeStat(
      target,
      {
        filter: cut.filter,
        rawBytes: cut.rawBytes,
        keptBytes: cut.keptBytes,
        bypassed: false,
        passedThrough: false,
      },
      deps.now(),
      deps.random,
    );
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', ...cut.output },
    });
  } catch {
    return '';
  }
};
