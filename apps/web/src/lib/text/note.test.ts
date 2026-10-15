import { describe, expect, test } from 'bun:test';
import type { TextFieldView } from '@agentdock/shared';
import { findFieldView, noteModel } from './note';

const view = (over: Partial<TextFieldView>): TextFieldView => ({
  ownerType: 'board_card',
  ownerId: 'c1',
  field: 'title',
  status: 'english',
  normalizationId: 'n1',
  retryable: false,
  ...over,
});

describe('noteModel', () => {
  test('normalizing shows the spinner state', () => {
    expect(noteModel(view({ status: 'normalizing' }), true)).toEqual({
      kind: 'normalizing',
    });
  });

  test('normalized offers the original', () => {
    expect(
      noteModel(view({ status: 'normalized', original: 'Привет' }), false),
    ).toEqual({ kind: 'original', original: 'Привет' });
  });

  test('english and no request show nothing', () => {
    expect(noteModel(view({ status: 'english' }), true)).toEqual({
      kind: 'none',
    });
    expect(noteModel(undefined, true)).toEqual({ kind: 'none' });
  });

  test('not_normalized carries the reason; Retry only for an operator on a failed request', () => {
    const failed = view({
      status: 'not_normalized',
      reason: 'runner_offline',
      retryable: true,
    });
    const operator = noteModel(failed, true);
    const viewer = noteModel(failed, false);
    expect(operator).toMatchObject({ kind: 'not_normalized', canRetry: true });
    expect(viewer).toMatchObject({ kind: 'not_normalized', canRetry: false });
    const skipped = noteModel(
      view({ status: 'not_normalized', reason: 'off', retryable: false }),
      true,
    );
    expect(skipped).toMatchObject({ canRetry: false });
  });
});

describe('findFieldView', () => {
  test('matches owner type, id and field', () => {
    const a = view({ field: 'title' });
    const b = view({ field: 'body', status: 'normalizing' });
    expect(findFieldView([a, b], 'board_card', 'c1', 'body')).toBe(b);
    expect(findFieldView([a, b], 'board_card_round', 'c1', 'body')).toBe(
      undefined,
    );
  });
});
