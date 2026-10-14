import { describe, expect, it } from 'bun:test';
import {
  type CaptureContentRow,
  headBytes,
  selectCaptureInput,
  tailBytes,
  utf8ByteLength,
} from './capture-input';
import {
  CAPTURE_INPUT_MAX_BYTES,
  CAPTURE_PROMPT_HEAD_BYTES,
  CAPTURE_RESPONSE_TAIL_BYTES,
} from './capture-limits';

const words = (n: number, word = 'word'): string =>
  Array.from({ length: n }, () => word).join(' ');

const row = (
  id: number,
  kind: CaptureContentRow['kind'],
  text = words(40),
): CaptureContentRow => ({ id: String(id), kind, text });

describe('byte clipping', () => {
  it('never splits a code point', () => {
    expect(headBytes('aé語', 3)).toBe('aé');
    expect(headBytes('aé語', 5)).toBe('aé');
    expect(headBytes('aé語', 6)).toBe('aé語');
    expect(tailBytes('語éa', 3)).toBe('éa');
    expect(tailBytes('😀a', 4)).toBe('a');
    expect(utf8ByteLength('aé語😀')).toBe(10);
  });
});

describe('selectCaptureInput', () => {
  it('uses only prompts and responses — never tool input or output', () => {
    const result = selectCaptureInput(
      [
        row(1, 'prompt'),
        row(2, 'tool_input', 'SECRET_TOOL_INPUT '.repeat(50)),
        row(3, 'tool_output', 'SECRET_TOOL_OUTPUT '.repeat(50)),
        row(4, 'response'),
      ],
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => [i.id, i.kind])).toEqual([
      ['1', 'prompt'],
      ['4', 'response'],
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET_TOOL');
  });

  it('reads only rows after the watermark, so a second extraction never re-sends an id', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((id) =>
      row(id, id % 2 ? 'prompt' : 'response'),
    );
    const first = selectCaptureInput(rows.slice(0, 4), null);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.contentToId).toBe('4');

    const second = selectCaptureInput(
      [...rows, row(7, 'prompt')],
      first.contentToId,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const sent = new Set(first.items.map((i) => i.id));
    expect(second.items.map((i) => i.id)).toEqual(['5', '6', '7']);
    expect(second.items.some((i) => sent.has(i.id))).toBe(false);
    expect(second.contentFromId).toBe('5');
  });

  it('keeps the head of a prompt and the tail of a response', () => {
    const long = `${'H'.repeat(3000)}${'T'.repeat(3000)}`;
    const result = selectCaptureInput(
      [row(1, 'prompt', long), row(2, 'response', long)],
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [prompt, response] = result.items;
    expect(prompt.text).toBe('H'.repeat(CAPTURE_PROMPT_HEAD_BYTES));
    expect(prompt.clipped).toBe(true);
    expect(response.text).toBe('T'.repeat(CAPTURE_RESPONSE_TAIL_BYTES));
    expect(response.clipped).toBe(true);
  });

  it('takes the newest first within 24 KiB and moves the watermark past the rest', () => {
    // 20 prompts of 2 KiB each: only 12 fit.
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(i + 1, 'prompt', 'x'.repeat(CAPTURE_PROMPT_HEAD_BYTES)),
    );
    const result = selectCaptureInput(rows, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i + 9)),
    );
    expect(
      result.items.reduce((n, i) => n + utf8ByteLength(i.text), 0),
    ).toBeLessThanOrEqual(CAPTURE_INPUT_MAX_BYTES);
    expect(result.contentFromId).toBe('9');
    expect(result.contentToId).toBe('20');
  });

  it('orders ids numerically, past the safe integer range', () => {
    const big = 9007199254740993n;
    const result = selectCaptureInput(
      [
        { id: big + 1n, kind: 'response', text: words(40) },
        { id: big, kind: 'prompt', text: words(40) },
        { id: '9', kind: 'prompt', text: words(40) },
      ],
      '10',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.id)).toEqual([
      String(big),
      String(big + 1n),
    ]);
  });

  it('skips under 300 new characters', () => {
    expect(selectCaptureInput([row(1, 'prompt', 'fix it')], null)).toEqual({
      ok: false,
      reason: 'too_little',
      inputChars: 6,
    });
    expect(selectCaptureInput([row(1, 'prompt')], '1')).toEqual({
      ok: false,
      reason: 'too_little',
      inputChars: 0,
    });
  });
});
