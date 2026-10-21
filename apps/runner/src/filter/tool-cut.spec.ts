import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterStatRowSchema } from '@nautelle/shared';
import { tempDir } from '../testing/fixtures';
import {
  FILTER_PROJECT_ENV,
  FILTER_RUN_ENV,
  FILTER_RUN_KIND_ENV,
  FILTER_STATS_ENV,
  TECHNIQUE_GREP_CUT,
  TECHNIQUE_MCP_CUT,
  TECHNIQUE_WEBFETCH_CUT,
  TECHNIQUES_ENV,
} from './env';
import { runFilterCommand } from './main';
import type { StatsLine } from './stats';
import {
  claudeCodeVersion,
  GREP_CUT_ID,
  MCP_CUT_ID,
  runToolHook,
  TOOL_CUT_HEAD_CHARS,
  TOOL_CUT_MAX_CHARS,
  TOOL_CUT_TAIL_CHARS,
  WEBFETCH_CUT_ID,
} from './tool-cut';

type Json = Record<string, unknown>;

interface Recorded {
  claudeCode: string;
  tool_name: string;
  tool_input: Json;
  mcp_server?: Json;
  tool_response: unknown;
}

/** A `tool_response` recorded from the installed Claude Code (#747 D6). */
const recorded = (name: string): Recorded =>
  JSON.parse(
    readFileSync(
      join(import.meta.dir, 'fixtures', 'tool-response', name),
      'utf8',
    ),
  ) as Recorded;

const ALL_CUTS = [
  TECHNIQUE_MCP_CUT,
  TECHNIQUE_GREP_CUT,
  TECHNIQUE_WEBFETCH_CUT,
];

let dir = '';
let cleanup = () => {};
const now = Date.parse('2026-10-21T10:00:00Z');
const env = (overrides: Record<string, string | undefined> = {}) => ({
  [FILTER_STATS_ENV]: join(dir, 'filter-stats.jsonl'),
  [FILTER_PROJECT_ENV]: 'prj_a',
  [FILTER_RUN_ENV]: 'run_1',
  [FILTER_RUN_KIND_ENV]: 'card',
  [TECHNIQUES_ENV]: ALL_CUTS.join(','),
  AI_AGENT: 'claude-code_2-1-306_harness',
  ...overrides,
});

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});
afterEach(() => cleanup());

const stats = (): StatsLine[] => {
  const file = join(dir, 'filter-stats.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as StatsLine);
};

const payload = (
  fixture: Recorded,
  response: unknown = fixture.tool_response,
) =>
  JSON.stringify({
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: fixture.tool_name,
    tool_input: fixture.tool_input,
    ...(fixture.mcp_server ? { mcp_server: fixture.mcp_server } : {}),
    tool_response: response,
    cwd: dir,
  });

const hook = (stdin: string, e = env()) =>
  runToolHook(stdin, { env: e, now: () => now });

interface Output {
  hookSpecificOutput: {
    hookEventName: string;
    updatedMCPToolOutput?: unknown;
    updatedToolOutput?: Json;
  };
}

const parse = (out: string): Output['hookSpecificOutput'] => {
  const parsed = JSON.parse(out) as Output;
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  return parsed.hookSpecificOutput;
};

/** A text of exactly `length` characters whose head and tail are recognisable. */
const big = (length: number) => {
  const body = 'HEAD>';
  const lines: string[] = [body];
  let size = body.length;
  for (let i = 0; size < length; i++) {
    const line = `\nline ${i} of the long result`;
    lines.push(line);
    size += line.length;
  }
  const text = lines.join('');
  return `${text.slice(0, length - 5)}<TAIL`;
};

/** The marker's raw file path, read back from the cut text. */
const rawPath = (text: string) => {
  const found = /Full output: (\S+\.log) —/.exec(text);
  expect(found).not.toBeNull();
  return found?.[1] ?? '';
};

/** Checks a cut text against the full one: head, marker, tail, raw file. */
const expectCut = (kept: string, full: string) => {
  expect(kept.startsWith(full.slice(0, TOOL_CUT_HEAD_CHARS))).toBe(true);
  expect(kept.endsWith(full.slice(-TOOL_CUT_TAIL_CHARS))).toBe(true);
  const cut = full.length - TOOL_CUT_HEAD_CHARS - TOOL_CUT_TAIL_CHARS;
  expect(kept).toContain(
    `[… Nautelle token saver: ${cut.toLocaleString('en-US')} of ${full.length.toLocaleString('en-US')} characters cut from the middle. Full output: `,
  );
  const path = rawPath(kept);
  expect(path.startsWith(join(dir, 'raw'))).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(full);
  expect(kept.length).toBeLessThan(
    TOOL_CUT_HEAD_CHARS + TOOL_CUT_TAIL_CHARS + 300,
  );
};

/** Everything but `field` is as the tool returned it (D6). */
const expectSameShape = (updated: Json, original: Json, field: string) => {
  expect(Object.keys(updated)).toEqual(Object.keys(original));
  for (const key of Object.keys(original)) {
    if (key !== field) expect(updated[key]).toEqual(original[key]);
  }
};

describe('tool-hook: MCP results (#747 D5, D7)', () => {
  const fixture = recorded('mcp-text-and-image.json');
  const blocks = fixture.tool_response as Json[];
  const withText = (text: string) => [{ type: 'text', text }, blocks[1]];

  it('cuts a 40,000-character text to head, marker and tail, keeping the image', () => {
    const text = big(40_000);
    const updated = parse(hook(payload(fixture, withText(text))))
      .updatedMCPToolOutput as Json[];
    expect(updated).toHaveLength(2);
    expect(updated[0]?.type).toBe('text');
    expectCut(updated[0]?.text as string, text);
    expect(updated[1]).toEqual(blocks[1]);
  });

  it('joins the recorded shape’s text blocks, and drops none of its others', () => {
    const response = [
      { ...blocks[0], text: big(30_000) },
      blocks[1],
      blocks[2],
    ];
    const updated = parse(hook(payload(fixture, response)))
      .updatedMCPToolOutput as Json[];
    const full = `${response[0]?.text}\n${blocks[2]?.text}`;
    expectCut(updated[0]?.text as string, full);
    expect(updated.slice(1)).toEqual([blocks[1]]);
  });

  it('keeps a `{ content }` result’s other fields, and cuts a bare string', () => {
    const text = big(20_000);
    const wrapped = parse(
      hook(
        payload(fixture, { content: [{ type: 'text', text }], isError: false }),
      ),
    ).updatedMCPToolOutput as Json;
    expect(wrapped.isError).toBe(false);
    expectCut((wrapped.content as Json[])[0]?.text as string, text);
    const bare = parse(hook(payload(fixture, text)))
      .updatedMCPToolOutput as string;
    expectCut(bare, text);
  });

  it('writes one tool/mcp-cut row the API accepts', () => {
    hook(payload(fixture, withText(big(40_000))));
    const rows = stats();
    expect(rows).toHaveLength(1);
    const row = rows[0]?.row;
    expect(row?.filter).toBe(MCP_CUT_ID);
    expect(row?.rawBytes).toBe(40_000);
    expect(row?.keptBytes ?? 0).toBeLessThan(row?.rawBytes ?? 0);
    expect(row?.bypassed).toBe(false);
    expect(filterStatRowSchema.safeParse(row).success).toBe(true);
  });

  it('leaves a result at or under 16,000 characters alone', () => {
    expect(hook(payload(fixture, withText(big(TOOL_CUT_MAX_CHARS))))).toBe('');
    expect(hook(payload(fixture))).toBe('');
    expect(stats()).toEqual([]);
  });

  it('never cuts the runner’s own server, under any of its names', () => {
    for (const tool of [
      'mcp__nautelle__finish_card',
      'mcp__agentdock__finish_card',
      'mcp__plugin_nautelle_nautelle__status',
    ]) {
      const own = { ...fixture, tool_name: tool, mcp_server: undefined };
      expect(hook(payload(own, withText(big(40_000))))).toBe('');
    }
    const named = {
      ...fixture,
      tool_name: 'mcp__x__y',
      mcp_server: { name: 'nautelle' },
    };
    expect(hook(payload(named, withText(big(40_000))))).toBe('');
    expect(stats()).toEqual([]);
  });

  it('is off without mcp-cut, and not held back by the Claude Code version', () => {
    const stdin = payload(fixture, withText(big(40_000)));
    expect(hook(stdin, env({ [TECHNIQUES_ENV]: TECHNIQUE_GREP_CUT }))).toBe('');
    expect(hook(stdin, env({ AI_AGENT: undefined }))).not.toBe('');
  });
});

describe('tool-hook: Grep results (#747 D6)', () => {
  it.each([
    'grep-content.json',
    'grep-count.json',
  ])('cuts only `content` of the recorded %s shape', (name) => {
    const fixture = recorded(name);
    const original = fixture.tool_response as Json;
    const text = big(25_000);
    const response = { ...original, content: text };
    const updated = parse(hook(payload(fixture, response)))
      .updatedToolOutput as Json;
    expectSameShape(updated, response, 'content');
    expectCut(updated.content as string, text);
    expect(stats().map((s) => s.row.filter)).toEqual([GREP_CUT_ID]);
  });

  it('cuts a long files_with_matches list to its first and last entries', () => {
    const fixture = recorded('grep-files-with-matches.json');
    const original = fixture.tool_response as Json;
    const names = Array.from(
      { length: 1_000 },
      (_, i) => `src/module-${i}/index.ts`,
    );
    const response = {
      ...original,
      filenames: names,
      numFiles: 1_000,
      totalFiles: 1_000,
    };
    const updated = parse(hook(payload(fixture, response)))
      .updatedToolOutput as Json;
    expectSameShape(updated, response, 'filenames');
    const kept = updated.filenames as string[];
    const at = kept.findIndex((entry) =>
      entry.startsWith('[… Nautelle token saver:'),
    );
    expect(at).toBeGreaterThan(0);
    expect(kept.slice(0, at)).toEqual(names.slice(0, at));
    const tail = kept.slice(at + 1);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail).toEqual(names.slice(names.length - tail.length));
    expect(kept.slice(0, at).join('\n').length).toBeLessThanOrEqual(
      TOOL_CUT_HEAD_CHARS,
    );
    expect(tail.join('\n').length).toBeLessThanOrEqual(TOOL_CUT_TAIL_CHARS);
    const cut = names.length - at - tail.length;
    expect(kept[at]).toContain(`${cut} of 1,000 entries cut from the middle`);
    expect(readFileSync(rawPath(kept[at] ?? ''), 'utf8')).toBe(
      names.join('\n'),
    );
    const row = stats()[0]?.row;
    expect(row?.filter).toBe(GREP_CUT_ID);
    expect(row?.rawBytes).toBe(Buffer.byteLength(names.join('\n')));
    expect(row?.keptBytes).toBe(Buffer.byteLength(kept.join('\n')));
  });

  it('leaves the recorded results, all under the limit, alone', () => {
    for (const name of [
      'grep-content.json',
      'grep-count.json',
      'grep-files-with-matches.json',
    ]) {
      expect(hook(payload(recorded(name)))).toBe('');
    }
  });

  it('gives no output for a shape it does not recognise', () => {
    const fixture = recorded('grep-content.json');
    const original = fixture.tool_response as Json;
    const text = big(25_000);
    for (const response of [
      { ...original, mode: 'other', content: text },
      { ...original, content: 42 },
      { mode: 'files_with_matches', filenames: [text, 7] },
      text,
      [text],
    ]) {
      expect(hook(payload(fixture, response))).toBe('');
    }
    expect(stats()).toEqual([]);
  });

  it('is off without grep-cut, or on a Claude Code older than the recorded one', () => {
    const fixture = recorded('grep-content.json');
    const stdin = payload(fixture, {
      ...(fixture.tool_response as Json),
      content: big(25_000),
    });
    expect(hook(stdin, env({ [TECHNIQUES_ENV]: TECHNIQUE_MCP_CUT }))).toBe('');
    expect(hook(stdin, env({ AI_AGENT: 'claude-code_2-1-305_harness' }))).toBe(
      '',
    );
    expect(hook(stdin, env({ AI_AGENT: undefined }))).toBe('');
    expect(
      hook(stdin, env({ AI_AGENT: 'claude-code_2-2-0_harness' })),
    ).not.toBe('');
  });
});

describe('tool-hook: WebFetch results (#747 D6)', () => {
  const fixture = recorded('webfetch.json');
  const original = fixture.tool_response as Json;

  it('cuts only `result` of the recorded shape', () => {
    const text = big(50_000);
    const response = { ...original, result: text };
    const updated = parse(hook(payload(fixture, response)))
      .updatedToolOutput as Json;
    expectSameShape(updated, response, 'result');
    expectCut(updated.result as string, text);
    expect(stats().map((s) => s.row.filter)).toEqual([WEBFETCH_CUT_ID]);
  });

  it('leaves the recorded result alone, and an unknown shape gets no output', () => {
    expect(hook(payload(fixture))).toBe('');
    const { url: _url, ...noUrl } = original;
    expect(hook(payload(fixture, { ...noUrl, result: big(50_000) }))).toBe('');
    expect(hook(payload(fixture, big(50_000)))).toBe('');
  });

  it('is off without webfetch-cut, or on an older Claude Code', () => {
    const stdin = payload(fixture, { ...original, result: big(50_000) });
    expect(hook(stdin, env({ [TECHNIQUES_ENV]: TECHNIQUE_GREP_CUT }))).toBe('');
    expect(hook(stdin, env({ AI_AGENT: 'claude-code_2-0-999_agent' }))).toBe(
      '',
    );
  });
});

describe('tool-hook: fail open (#747)', () => {
  const fixture = recorded('webfetch.json');
  const stdin = () =>
    payload(fixture, {
      ...(fixture.tool_response as Json),
      result: big(50_000),
    });

  it('prints nothing for malformed input, another event or no launch env', () => {
    for (const bad of ['', 'not json', 'null', '[]', '{"tool_name":7}']) {
      expect(hook(bad)).toBe('');
    }
    const pre = JSON.parse(stdin()) as Json;
    expect(
      hook(JSON.stringify({ ...pre, hook_event_name: 'PreToolUse' })),
    ).toBe('');
    expect(hook(stdin(), env({ [FILTER_STATS_ENV]: undefined }))).toBe('');
    expect(hook(stdin(), env({ [TECHNIQUES_ENV]: undefined }))).toBe('');
  });

  it('prints nothing, and writes no row, when the raw dir cannot be written', () => {
    writeFileSync(join(dir, 'raw'), 'a file where the raw dir would be');
    expect(hook(stdin())).toBe('');
    expect(stats()).toEqual([]);
  });

  it('prints the replacement from the subcommand, and nothing on bad input, exiting 0', async () => {
    const run = async (input: string) => {
      const out: string[] = [];
      const code = await runFilterCommand(['tool-hook'], {
        env: env(),
        stdout: (b) => out.push(String(b)),
        stderr: () => {},
        stdin: async () => input,
        flush: async () => {},
      });
      expect(code).toBe(0);
      return out;
    };
    expect(await run('{')).toEqual([]);
    const out = await run(stdin());
    expect(out).toHaveLength(1);
    expect(parse(out[0] ?? '').updatedToolOutput?.url).toBe(
      'https://example.com',
    );
  });
});

describe('claudeCodeVersion', () => {
  it('reads AI_AGENT, then the exec path, else null', () => {
    expect(
      claudeCodeVersion({ AI_AGENT: 'claude-code_2-1-306_harness' }),
    ).toEqual([2, 1, 306]);
    expect(
      claudeCodeVersion({
        CLAUDE_CODE_EXECPATH: '/home/u/.local/share/claude/versions/2.1.310',
      }),
    ).toEqual([2, 1, 310]);
    expect(claudeCodeVersion({ AI_AGENT: 'cursor_1-0-0' })).toBeNull();
    expect(claudeCodeVersion({})).toBeNull();
  });
});
