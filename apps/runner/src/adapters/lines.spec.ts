import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/fixtures';
import { type LineBatch, MAX_LINE_BYTES, readLines } from './lines';

const MIB = 1024 * 1024;

describe('readLines', () => {
  let path = '';
  let cleanup = () => {};
  beforeEach(() => {
    const temp = tempDir();
    path = join(temp.dir, 'transcript.jsonl');
    cleanup = temp.cleanup;
  });
  afterEach(() => cleanup());

  const collect = async (
    offset = 0,
    maxLineBytes?: number,
  ): Promise<{
    batches: LineBatch[];
    dropped: { offset: number; bytes: number }[];
  }> => {
    const batches: LineBatch[] = [];
    const dropped: { offset: number; bytes: number }[] = [];
    for await (const batch of readLines(path, offset, {
      maxLineBytes,
      onDropped: (drop) => dropped.push(drop),
    })) {
      batches.push(batch);
    }
    return { batches, dropped };
  };

  it('reads complete lines and leaves a partial last line for later', async () => {
    writeFileSync(path, 'one\ntwo\nthr');
    const { batches } = await collect();
    expect(batches).toEqual([{ lines: ['one', 'two'], nextOffset: 8 }]);
  });

  it('drops a 64 MiB line with a warning and goes on with the next line', async () => {
    const huge = Buffer.alloc(64 * MIB, 'a');
    writeFileSync(
      path,
      Buffer.concat([Buffer.from('first\n'), huge, Buffer.from('\nnext\n')]),
    );
    expect(huge.length).toBeGreaterThan(MAX_LINE_BYTES);
    const { batches, dropped } = await collect();
    expect(dropped).toEqual([{ offset: 6, bytes: 64 * MIB }]);
    expect(batches.flatMap((b) => b.lines)).toEqual(['first', 'next']);
    expect(batches.at(-1)?.nextOffset).toBe(6 + 64 * MIB + 1 + 5);
  });

  it('moves the offset past a dropped line even when no line follows', async () => {
    writeFileSync(path, `${'x'.repeat(40)}\n`);
    const { batches, dropped } = await collect(0, 16);
    expect(dropped).toEqual([{ offset: 0, bytes: 40 }]);
    expect(batches).toEqual([{ lines: [], nextOffset: 41 }]);
  });

  it('does not consume an oversized line still being written', async () => {
    writeFileSync(path, `ok\n${'x'.repeat(40)}`);
    const { batches, dropped } = await collect(0, 16);
    expect(dropped).toEqual([]);
    expect(batches).toEqual([{ lines: ['ok'], nextOffset: 3 }]);
  });
});
