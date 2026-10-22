import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { filterStatRowSchema } from '@nautelle/shared';
import { tempDir } from '../testing/fixtures';
import {
  FILTER_PROJECT_ENV,
  FILTER_RUN_ENV,
  FILTER_RUN_KIND_ENV,
  FILTER_STATS_ENV,
  TECHNIQUE_READ_GUARD_400,
  TECHNIQUES_ENV,
} from './env';
import { runFilterCommand } from './main';
import {
  type DenyOutput,
  READ_DEDUP_ID,
  READ_GUARD_BYTES,
  READ_GUARD_DIR,
  READ_GUARD_ID,
  READ_GUARD_LINES,
  READ_GUARD_LINES_TIGHT,
  runReadHook,
} from './read-guard';
import type { StatsLine } from './stats';

let dir = '';
let cleanup = () => {};
let now = Date.parse('2026-10-17T10:00:00Z');
const env = () => ({
  [FILTER_STATS_ENV]: join(dir, 'filter-stats.jsonl'),
  [FILTER_PROJECT_ENV]: 'prj_a',
  [FILTER_RUN_ENV]: 'run_1',
  [FILTER_RUN_KIND_ENV]: 'card',
});
const deps = () => ({ env: env(), now: () => now });

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
  now = Date.parse('2026-10-17T10:00:00Z');
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
  event: string,
  input: Record<string, unknown>,
  tool = 'Read',
) =>
  JSON.stringify({
    session_id: 's1',
    hook_event_name: event,
    tool_name: tool,
    tool_input: input,
    cwd: dir,
  });

/** One read as Claude Code runs it: PreToolUse, and PostToolUse if it ran. */
const read = (input: Record<string, unknown>): DenyOutput | null => {
  const out = runReadHook(payload('PreToolUse', input), deps());
  if (out) return JSON.parse(out) as DenyOutput;
  expect(runReadHook(payload('PostToolUse', input), deps())).toBe('');
  return null;
};

const bigFile = (): string => {
  const path = join(dir, 'big.ts');
  writeFileSync(path, 'export const x = 1;\n'.repeat(READ_GUARD_LINES + 1));
  return path;
};

describe('read-hook: the whole-read guard (#616)', () => {
  it('refuses a whole read over the line threshold once, with guidance', () => {
    const path = bigFile();
    const denied = read({ file_path: path });
    expect(denied?.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = denied?.hookSpecificOutput.permissionDecisionReason ?? '';
    expect(reason).toContain('1,501 lines');
    expect(reason).toContain('offset/limit');
    expect(reason).toContain('Grep');
    expect(reason).toContain('scout');
    // The immediate retry runs.
    expect(read({ file_path: path })).toBeNull();
  });

  it('refuses one over the byte threshold, even with few lines', () => {
    const path = join(dir, 'wide.json');
    writeFileSync(path, `${'x'.repeat(READ_GUARD_BYTES + 1)}\n`);
    expect(read({ file_path: path })).not.toBeNull();
  });

  it('lets a small file, a ranged read and a binary file through', () => {
    const small = join(dir, 'small.ts');
    writeFileSync(small, 'a\n'.repeat(READ_GUARD_LINES));
    expect(read({ file_path: small })).toBeNull();
    const path = bigFile();
    expect(read({ file_path: path, offset: 1, limit: 100 })).toBeNull();
    const binary = join(dir, 'blob.bin');
    writeFileSync(binary, Buffer.alloc(READ_GUARD_BYTES * 2));
    expect(read({ file_path: binary })).toBeNull();
    const image = join(dir, 'shot.png');
    writeFileSync(image, 'x'.repeat(READ_GUARD_BYTES * 2));
    expect(read({ file_path: image })).toBeNull();
    expect(stats()).toEqual([]);
  });

  it('writes a row the API accepts: its own id, the bytes it kept out', () => {
    const path = bigFile();
    const size = readFileSync(path).length;
    const reason =
      read({ file_path: path })?.hookSpecificOutput.permissionDecisionReason ??
      '';
    read({ file_path: path });
    const rows = stats();
    expect(rows.map((r) => r.projectId)).toEqual(['prj_a', 'prj_a']);
    expect(rows[0]?.row).toMatchObject({
      filter: READ_GUARD_ID,
      runId: 'run_1',
      runKind: 'card',
      rawBytes: size,
      keptBytes: Buffer.byteLength(reason),
      bypassed: false,
      passedThrough: false,
    });
    // The retry it let through: bypassed, no bytes.
    expect(rows[1]?.row).toMatchObject({
      filter: READ_GUARD_ID,
      rawBytes: 0,
      keptBytes: 0,
      bypassed: true,
    });
    for (const { row } of rows) {
      expect(filterStatRowSchema.safeParse(row).success).toBe(true);
    }
  });
});

describe('read-hook: the 400-line guard with an outline (#747)', () => {
  const tightDeps = () => ({
    env: { ...env(), [TECHNIQUES_ENV]: TECHNIQUE_READ_GUARD_400 },
    now: () => now,
  });
  const tightRead = (input: Record<string, unknown>): DenyOutput | null => {
    const out = runReadHook(payload('PreToolUse', input), tightDeps());
    if (out) return JSON.parse(out) as DenyOutput;
    runReadHook(payload('PostToolUse', input), tightDeps());
    return null;
  };
  const lines = (count: number): string =>
    Array.from(
      { length: count },
      (_, i) => `export const v${i} = ${i};\n`,
    ).join('');

  it('reads a 400-line file and refuses a 401-line one once, with the outline', () => {
    const ok = join(dir, 'ok.ts');
    writeFileSync(ok, lines(READ_GUARD_LINES_TIGHT));
    expect(tightRead({ file_path: ok })).toBeNull();

    const big = join(dir, 'big.ts');
    writeFileSync(big, lines(READ_GUARD_LINES_TIGHT + 1));
    const reason =
      tightRead({ file_path: big })?.hookSpecificOutput
        .permissionDecisionReason ?? '';
    expect(reason).toContain('401 lines');
    expect(reason).toContain('Outline:');
    expect(reason).toContain('  1: export const v0 = 0;');
    expect(reason).toContain('(361 more, sampled)');
    expect(reason).toContain('offset/limit');
    // The immediate retry runs.
    expect(tightRead({ file_path: big })).toBeNull();
  });

  it('says when a file has no outline', () => {
    const path = join(dir, 'notes.txt');
    writeFileSync(path, 'prose\n'.repeat(500));
    const reason =
      tightRead({ file_path: path })?.hookSpecificOutput
        .permissionDecisionReason ?? '';
    expect(reason).toContain(
      'No outline (no headings or top-level declarations found).',
    );
  });

  it('outlines Markdown by its headings', () => {
    const path = join(dir, 'doc.md');
    writeFileSync(path, `# Top\n${'text\n'.repeat(500)}## Later\n`);
    const reason =
      tightRead({ file_path: path })?.hookSpecificOutput
        .permissionDecisionReason ?? '';
    expect(reason).toContain('  1: # Top');
    expect(reason).toContain('  502: ## Later');
  });

  it('keeps the byte threshold and the ranged read', () => {
    const wide = join(dir, 'wide.json');
    writeFileSync(wide, `${'x'.repeat(READ_GUARD_BYTES + 1)}\n`);
    expect(tightRead({ file_path: wide })).not.toBeNull();
    const big = join(dir, 'big.ts');
    writeFileSync(big, lines(READ_GUARD_LINES_TIGHT + 1));
    expect(tightRead({ file_path: big, offset: 1, limit: 100 })).toBeNull();
  });

  it('is unchanged without the flag: 1,500 lines, no outline', () => {
    const path = join(dir, 'mid.ts');
    writeFileSync(path, lines(READ_GUARD_LINES_TIGHT + 1));
    expect(read({ file_path: path })).toBeNull();
    const reason =
      read({ file_path: bigFile() })?.hookSpecificOutput
        .permissionDecisionReason ?? '';
    expect(reason).not.toContain('Outline');
    expect(reason).toContain('1,501 lines');
  });

  it('writes the same stats ids as the 1,500-line guard', () => {
    const big = join(dir, 'big.ts');
    writeFileSync(big, lines(READ_GUARD_LINES_TIGHT + 1));
    tightRead({ file_path: big });
    tightRead({ file_path: big });
    expect(stats().map((r) => r.row.filter)).toEqual([
      READ_GUARD_ID,
      READ_GUARD_ID,
    ]);
  });
});

describe('read-hook: the repeated-read dedup (#616)', () => {
  const file = (): string => {
    const path = join(dir, 'a.ts');
    writeFileSync(path, 'const a = 1;\n'.repeat(200));
    return path;
  };

  it('reminds instead of re-reading an unchanged range, once', () => {
    const path = file();
    expect(read({ file_path: path, offset: 10, limit: 50 })).toBeNull();
    now += 60_000;
    const denied = read({ file_path: path, offset: 10, limit: 50 });
    expect(denied?.hookSpecificOutput.permissionDecisionReason).toContain(
      'already in your context since 10:00:00 UTC',
    );
    expect(read({ file_path: path, offset: 10, limit: 50 })).toBeNull();
    const rows = stats().map((l) => l.row);
    expect(rows.map((r) => [r.filter, r.bypassed])).toEqual([
      [READ_DEDUP_ID, false],
      [READ_DEDUP_ID, true],
    ]);
    // 50 of 200 equal lines.
    expect(rows[0]?.rawBytes).toBe(650);
    for (const row of rows) {
      expect(filterStatRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('reads another range of the same file', () => {
    const path = file();
    expect(read({ file_path: path })).toBeNull();
    expect(read({ file_path: path, offset: 10, limit: 50 })).toBeNull();
  });

  it('reads the file again after it changed', () => {
    const path = file();
    expect(read({ file_path: path })).toBeNull();
    appendFileSync(path, 'const b = 2;\n');
    expect(read({ file_path: path })).toBeNull();
    // Same size, new mtime.
    const later = new Date(now + 5_000);
    utimesSync(path, later, later);
    expect(read({ file_path: path })).toBeNull();
    expect(stats()).toEqual([]);
  });

  it('forgets every read when the session compacts', () => {
    const path = file();
    expect(read({ file_path: path })).toBeNull();
    runReadHook(
      JSON.stringify({ session_id: 's1', hook_event_name: 'PreCompact' }),
      deps(),
    );
    expect(read({ file_path: path })).toBeNull();
  });

  it('keeps each session’s reads apart, in the run dir', () => {
    const path = file();
    expect(read({ file_path: path })).toBeNull();
    expect(existsSync(join(dir, READ_GUARD_DIR, 's1.json'))).toBe(true);
    const other = JSON.parse(payload('PreToolUse', { file_path: path }));
    other.session_id = 's2';
    expect(runReadHook(JSON.stringify(other), deps())).toBe('');
  });
});

describe('read-hook fails open (#616)', () => {
  it('decides nothing without the launch’s env', () => {
    const path = bigFile();
    expect(
      runReadHook(payload('PreToolUse', { file_path: path }), {
        env: {},
        now: () => now,
      }),
    ).toBe('');
  });

  it('decides nothing on input it cannot use', () => {
    const path = bigFile();
    for (const input of [
      '',
      'not json',
      'null',
      '{"hook_event_name":"PreToolUse","tool_name":"Read"}',
      payload('PreToolUse', { file_path: 'relative.ts' }),
      payload('PreToolUse', { file_path: join(dir, 'missing.ts') }),
      payload('PreToolUse', { file_path: dir }),
      payload('PreToolUse', { command: 'cat x' }, 'Bash'),
      JSON.stringify({
        session_id: '../escape',
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: path },
      }),
    ]) {
      expect(runReadHook(input, deps())).toBe('');
    }
  });

  it('lets the read run when its memory cannot be written', () => {
    const path = bigFile();
    // A file where the memory's directory should be.
    writeFileSync(join(dir, READ_GUARD_DIR), '');
    expect(
      runReadHook(payload('PreToolUse', { file_path: path }), deps()),
    ).toBe('');
  });

  it('exits 0 with no output from the subcommand', async () => {
    const out: string[] = [];
    for (const stdin of ['', 'not json', '{"tool_name":"Read"}']) {
      const code = await runFilterCommand(['read-hook'], {
        env: env(),
        stdout: (b) => out.push(String(b)),
        stderr: () => {},
        stdin: async () => stdin,
        flush: async () => {},
      });
      expect(code).toBe(0);
    }
    expect(out).toEqual([]);
  });

  it('prints the refusal from the subcommand', async () => {
    const out: string[] = [];
    await runFilterCommand(['read-hook'], {
      env: env(),
      stdout: (b) => out.push(String(b)),
      stderr: () => {},
      stdin: async () => payload('PreToolUse', { file_path: bigFile() }),
      flush: async () => {},
    });
    expect(
      (JSON.parse(out.join('')) as DenyOutput).hookSpecificOutput
        .permissionDecision,
    ).toBe('deny');
  });
});
