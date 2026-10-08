import type {
  PaneFrame,
  PaneFullFrame,
  PanePatchFrame,
} from '@agentdock/shared/protocol';

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

/** Cuts `line` until its JSON encoding fits `budget` bytes. */
const truncate = (line: string, budget: number): string => {
  let cut = line;
  for (let size = bytes(cut); size > budget && cut.length > 0; ) {
    const keep = Math.floor((cut.length * budget) / size) - 1;
    cut = cut.slice(0, Math.max(0, Math.min(keep, cut.length - 1)));
    size = bytes(cut);
  }
  return cut;
};

/**
 * Splits a frame whose JSON exceeds `maxBytes` into several that each fit,
 * using the frame semantics themselves (spec 18, i18-api note): a `full`
 * becomes `full { first lines, cursor }` followed by `patch { from, rest }`
 * frames, and a long `patch` becomes consecutive patches. Since a patch
 * replaces everything from `from` to the end, applying the pieces in order
 * yields exactly the original frame. A single line that alone cannot fit is
 * truncated — the only lossy case. `ended` is returned unchanged.
 */
export const chunkPaneFrame = (
  frame: PaneFrame,
  maxBytes: number,
): PaneFrame[] => {
  if (frame.type === 'ended' || bytes(frame) <= maxBytes) return [frame];

  const offset = frame.type === 'patch' ? frame.from : 0;
  const head = (lines: string[]): PaneFullFrame | PanePatchFrame =>
    frame.type === 'full'
      ? { type: 'full', lines, cursor: frame.cursor }
      : { type: 'patch', from: offset, lines };
  const tail = (from: number, lines: string[]): PanePatchFrame => ({
    type: 'patch',
    from: offset + from,
    lines,
  });

  const out: PaneFrame[] = [];
  let start = 0;
  let lines: string[] = [];
  // Empty frame plus the comma each line adds; the larger of the two shapes.
  const base = Math.max(bytes(head([])), bytes(tail(frame.lines.length, [])));
  let size = base;
  const flush = () => {
    out.push(out.length === 0 ? head(lines) : tail(start, lines));
    start += lines.length;
    lines = [];
    size = base;
  };

  for (const original of frame.lines) {
    const line = truncate(original, maxBytes - base - 1);
    const cost = bytes(line) + 1;
    if (lines.length > 0 && size + cost > maxBytes) flush();
    lines.push(line);
    size += cost;
  }
  flush();
  return out;
};
