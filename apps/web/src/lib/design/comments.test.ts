import { describe, expect, test } from 'bun:test';
import { type CardStackRef, STACK_GATE_REASON } from '@nautelle/shared';
import {
  anchorLabel,
  approveBlock,
  designWriteBlock,
  framesWithOpenPins,
  groupComments,
  openCommentsByFrame,
  pinMarkers,
  pinNumbers,
  reviseBlock,
  stackDrawBlock,
} from './comments';
import { comment, design } from './fixtures';

const pin = (
  id: string,
  at: string,
  viewport: string,
  theme: 'light' | 'dark',
) =>
  comment({
    id,
    kind: 'pin',
    viewport,
    theme,
    x: 10,
    y: 20,
    selector: 'main',
    createdAt: at,
  });

describe('groupComments', () => {
  const list = [
    comment({ id: 'b', createdAt: '2026-10-14T10:02:00.000Z' }),
    comment({ id: 'a', createdAt: '2026-10-14T10:01:00.000Z' }),
    comment({ id: 'done', addressedInRevisionId: 'rev-1-2' }),
    comment({ id: 'old', revisionId: 'rev-0' }),
  ];

  test('open and addressed, oldest first, for the revision in view', () => {
    const groups = groupComments(list, 'rev-1-1', false);
    expect(groups.open.map((c) => c.id)).toEqual(['a', 'b']);
    expect(groups.addressed.map((c) => c.id)).toEqual(['done']);
  });

  test('one frame of the revision on request, and counts per frame (#441)', () => {
    const framed = [
      comment({ id: 'f0' }),
      comment({ id: 'f1', frame: 1 }),
      comment({ id: 'f1-done', frame: 1, addressedInRevisionId: 'rev-1-2' }),
    ];
    expect(
      groupComments(framed, 'rev-1-1', false, 1).open.map((c) => c.id),
    ).toEqual(['f1']);
    expect(
      groupComments(framed, 'rev-1-1', false).open.map((c) => c.id),
    ).toEqual(['f0', 'f1']);
    expect([...openCommentsByFrame(framed, 'rev-1-1')]).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  test('all revisions on request', () => {
    expect(
      groupComments(list, 'rev-1-1', true).open.map((c) => c.id),
    ).toContain('old');
  });
});

describe('pins', () => {
  const list = [
    pin('p2', '2026-10-14T10:02:00.000Z', 'Mobile', 'dark'),
    pin('p1', '2026-10-14T10:01:00.000Z', 'Desktop', 'light'),
    pin('p3', '2026-10-14T10:03:00.000Z', 'Mobile', 'light'),
    comment({ id: 'g' }),
  ];

  test('number by age across screens, so a number never changes with the screen', () => {
    const numbers = pinNumbers(list, 'rev-1-1');
    expect([...numbers.entries()]).toEqual([
      ['p1', 1],
      ['p2', 2],
      ['p3', 3],
    ]);
  });

  test('a pin left at Mobile/dark shows only at Mobile/dark', () => {
    expect(pinMarkers(list, 'rev-1-1', 'Mobile', 'dark')).toEqual([
      { n: 2, x: 10, y: 20 },
    ]);
    expect(pinMarkers(list, 'rev-1-1', 'Mobile', 'light')).toEqual([
      { n: 3, x: 10, y: 20 },
    ]);
    expect(pinMarkers(list, 'rev-other', 'Mobile', 'dark')).toEqual([]);
  });

  test('a pin shows only on the frame it was made on (#441)', () => {
    const framed = [
      { ...pin('f0', '2026-10-14T10:01:00.000Z', 'Mobile', 'dark'), frame: 0 },
      { ...pin('f2', '2026-10-14T10:02:00.000Z', 'Mobile', 'dark'), frame: 2 },
    ];
    expect(pinMarkers(framed, 'rev-1-1', 'Mobile', 'dark', 2)).toEqual([
      { n: 2, x: 10, y: 20 },
    ]);
    expect(pinMarkers(framed, 'rev-1-1', 'Mobile', 'dark')).toEqual([
      { n: 1, x: 10, y: 20 },
    ]);
    expect([...framesWithOpenPins(framed, 'rev-1-1')]).toEqual([0, 2]);
  });

  test('anchor labels', () => {
    expect(anchorLabel(list[0], 2)).toBe('Pin 2 · Mobile · dark');
    const screen = comment({
      kind: 'screen',
      viewport: 'Desktop',
      theme: 'light',
    });
    expect(anchorLabel(screen)).toBe('Desktop · light');
    expect(anchorLabel(comment())).toBeNull();
  });
});

describe('what the design takes now', () => {
  test('a viewer reads only', () => {
    expect(designWriteBlock(design(), false)).toMatch(/Viewers/);
  });

  test('nothing while a turn runs, or once approved', () => {
    const block = (over: Parameters<typeof design>[0]) =>
      designWriteBlock(design(over), true);
    expect(block({ activeTurnId: 't' })).toMatch(/design run is under way/);
    expect(block({ status: 'approved' })).toMatch(/approved/);
    expect(block({ needed: false })).toMatch(/off/);
  });

  test('Revise needs an open comment', () => {
    expect(reviseBlock(design(), true)).toMatch(/comment first/);
    expect(reviseBlock(design({ comments: [comment()] }), true)).toBeNull();
    expect(
      reviseBlock(
        design({ comments: [comment({ addressedInRevisionId: 'r2' })] }),
        true,
      ),
    ).toMatch(/comment first/);
  });

  test('Approve needs a revision', () => {
    expect(approveBlock(design(), true)).toBeNull();
    expect(approveBlock(design({ revisions: [] }), true)).toMatch(/Generate/);
  });
});

describe('stackDrawBlock (#527)', () => {
  const stack = (gate: string | null): CardStackRef => ({
    number: 1,
    label: 'S-1',
    title: 'Redesign the Settings page',
    stage: 1,
    stageTitle: 'Page',
    gate,
  });

  test('a stack card waits for the stack design, naming the stack', () => {
    const block = stackDrawBlock(stack(STACK_GATE_REASON));
    expect(block).toContain(STACK_GATE_REASON);
    expect(block).toContain('S-1 “Redesign the Settings page”');
  });

  test('a card in no stack, or one its stack lets draw, is not held', () => {
    expect(stackDrawBlock(undefined)).toBeNull();
    expect(stackDrawBlock(null)).toBeNull();
    expect(stackDrawBlock(stack(null))).toBeNull();
  });

  test('Revise waits for the stack design before asking for a comment', () => {
    const block = stackDrawBlock(stack(STACK_GATE_REASON));
    expect(reviseBlock(design(), true, block)).toBe(block);
    expect(reviseBlock(design({ comments: [comment()] }), true, block)).toBe(
      block,
    );
    expect(reviseBlock(design({ comments: [comment()] }), true, null)).toBe(
      null,
    );
  });
});
