import {
  CAPTURE_INPUT_MAX_BYTES,
  CAPTURE_PROMPT_HEAD_BYTES,
  CAPTURE_RESPONSE_TAIL_BYTES,
  type CaptureContentRow,
} from '@agentdock/shared';
import { prepareCaptureInput } from './capture-input';

const words = (n: number, word = 'note') =>
  Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

const row = (
  id: number,
  kind: CaptureContentRow['kind'],
  text: string,
): CaptureContentRow => ({ id: String(id), kind, text });

/** `id="…"` of every `<content>` element in the prompt. */
const idsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/<content id="(\d+)"/g)].map((m) => m[1]);

describe('prepareCaptureInput (D3)', () => {
  it('holds only prompt and response rows — never tool input or output', () => {
    const rows = [
      row(1, 'prompt', words(60, 'please')),
      row(2, 'tool_input', 'SECRET_TOKEN=abc rm -rf /tmp/x'),
      row(3, 'tool_output', 'SECRET_OUTPUT the file contents'),
      row(4, 'response', words(60, 'done')),
    ];
    const input = prepareCaptureInput(rows, null, ['Existing card']);
    if (!input.ok) throw new Error(input.reason);
    expect(idsIn(input.prompt)).toEqual(['1', '4']);
    expect(input.prompt).not.toContain('SECRET_TOKEN');
    expect(input.prompt).not.toContain('SECRET_OUTPUT');
    expect(input.prompt).toContain('- Existing card');
    expect(input.selection.contentToId).toBe('4');
  });

  it('reads only rows after the watermark', () => {
    const rows = [
      row(1, 'prompt', words(80, 'old')),
      row(2, 'response', words(80, 'old')),
      row(3, 'prompt', words(80, 'new')),
      row(4, 'response', words(80, 'new')),
    ];
    const input = prepareCaptureInput(rows, 2n, []);
    if (!input.ok) throw new Error(input.reason);
    expect(idsIn(input.prompt)).toEqual(['3', '4']);
    expect(input.prompt).not.toContain('old0');
  });

  it('caps each row and the total, keeping the newest', () => {
    const big = 'x'.repeat(8 * 1024);
    const rows = [
      ...Array.from({ length: 30 }, (_, i) =>
        row(i * 2 + 1, 'prompt', `p${i} ${big}`),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        row(i * 2 + 2, 'response', `${big} r${i}`),
      ),
    ];
    const input = prepareCaptureInput(rows, null, []);
    if (!input.ok) throw new Error(input.reason);
    const { items } = input.selection;
    for (const item of items) {
      const bytes = Buffer.byteLength(item.text);
      expect(bytes).toBeLessThanOrEqual(
        item.kind === 'prompt'
          ? CAPTURE_PROMPT_HEAD_BYTES
          : CAPTURE_RESPONSE_TAIL_BYTES,
      );
      expect(item.clipped).toBe(true);
    }
    // A prompt keeps its head, a response its tail.
    expect(items.find((i) => i.kind === 'prompt')?.text).toMatch(/^p\d+ /);
    expect(items.find((i) => i.kind === 'response')?.text).toMatch(/ r\d+$/);
    const total = items.reduce((n, i) => n + Buffer.byteLength(i.text), 0);
    expect(total).toBeLessThanOrEqual(CAPTURE_INPUT_MAX_BYTES);
    // Newest first until the budget: the newest id is in, the oldest out.
    expect(input.selection.contentToId).toBe('60');
    expect(idsIn(input.prompt)).toContain('60');
    expect(idsIn(input.prompt)).not.toContain('1');
  });

  it('skips under 300 characters of new content, keeping the watermark', () => {
    const input = prepareCaptureInput(
      [row(5, 'prompt', 'fix it'), row(6, 'response', 'ok')],
      4n,
      [],
    );
    expect(input).toMatchObject({ ok: false, reason: 'too_little' });
  });

  it('never re-sends a content id: the next extraction starts after the last', () => {
    const first = [
      row(1, 'prompt', words(60, 'a')),
      row(2, 'tool_output', words(60, 'tool')),
      row(3, 'response', words(60, 'b')),
    ];
    const one = prepareCaptureInput(first, null, []);
    if (!one.ok) throw new Error(one.reason);
    const watermark = BigInt(one.selection.contentToId);

    // The session went on; the API loads every row again.
    const all = [
      ...first,
      row(4, 'prompt', words(60, 'c')),
      row(5, 'response', words(60, 'd')),
    ];
    const two = prepareCaptureInput(all, watermark, []);
    if (!two.ok) throw new Error(two.reason);
    const sentFirst = new Set(idsIn(one.prompt));
    expect(idsIn(two.prompt)).toEqual(['4', '5']);
    for (const id of idsIn(two.prompt)) expect(sentFirst.has(id)).toBe(false);

    // Nothing new: nothing to send.
    const three = prepareCaptureInput(
      all,
      BigInt(two.selection.contentToId),
      [],
    );
    expect(three.ok).toBe(false);
  });

  it('passes over rows older than the budget, never sending them later', () => {
    const big = 'y'.repeat(2048);
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(i + 1, 'prompt', big),
    );
    const one = prepareCaptureInput(rows, null, []);
    if (!one.ok) throw new Error(one.reason);
    expect(idsIn(one.prompt)).not.toContain('1');
    const two = prepareCaptureInput(
      rows,
      BigInt(one.selection.contentToId),
      [],
    );
    expect(two.ok).toBe(false);
  });
});
