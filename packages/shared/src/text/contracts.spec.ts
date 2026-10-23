import { describe, expect, it } from 'bun:test';
import { textFieldsSchema, textFieldView, textSourceHash } from './contracts';
import { isTextField, textOfflineBackoffMs } from './limits';

const owner = { ownerType: 'board_card' as const, ownerId: 'c1' };
const row = (
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'superseded',
  failReason: 'runner_offline' | 'off' | null = null,
) => ({ id: 'n1', status, failReason });

describe('textSourceHash', () => {
  it('is the hex SHA-256 of the UTF-8 text', () => {
    expect(textSourceHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('textFieldsSchema', () => {
  const field = {
    field: 'title',
    original: 'Почини',
    sourceHash: textSourceHash('Почини'),
  };

  it('accepts distinct fields', () => {
    expect(
      textFieldsSchema.safeParse([field, { ...field, field: 'body' }]).success,
    ).toBe(true);
  });

  it('refuses no field, a repeated field and an over-long original', () => {
    expect(textFieldsSchema.safeParse([]).success).toBe(false);
    expect(textFieldsSchema.safeParse([field, field]).success).toBe(false);
    expect(
      textFieldsSchema.safeParse([{ ...field, original: 'x'.repeat(20_001) }])
        .success,
    ).toBe(false);
  });
});

describe('textFieldView', () => {
  const f = { field: 'title', original: 'Почини' };

  it('maps a request in flight to normalizing', () => {
    expect(textFieldView(owner, row('pending'), f).status).toBe('normalizing');
    expect(textFieldView(owner, row('running'), f).status).toBe('normalizing');
  });

  it('shows the original only for a translated field', () => {
    expect(
      textFieldView(owner, row('done'), { ...f, outcome: 'translated' }),
    ).toEqual({
      ...owner,
      field: 'title',
      status: 'normalized',
      original: 'Почини',
      normalizationId: 'n1',
      retryable: false,
    });
    expect(
      textFieldView(owner, row('pending'), { ...f, outcome: 'already_english' })
        .status,
    ).toBe('english');
  });

  it('maps a failure or a skip to not_normalized with its reason, retryable only when failed', () => {
    expect(
      textFieldView(owner, row('failed', 'runner_offline'), f),
    ).toMatchObject({
      status: 'not_normalized',
      reason: 'runner_offline',
      retryable: true,
    });
    expect(textFieldView(owner, row('skipped', 'off'), f)).toMatchObject({
      status: 'not_normalized',
      reason: 'off',
      retryable: false,
    });
    expect(
      textFieldView(owner, row('done'), { ...f, outcome: 'rejected' }),
    ).toMatchObject({ status: 'not_normalized', reason: 'rejected' });
    expect(
      textFieldView(owner, row('done'), { ...f, outcome: 'too_long' }),
    ).toMatchObject({ status: 'not_normalized', reason: 'too_long' });
  });
});

describe('isTextField', () => {
  it('knows each owner’s fields and a turn’s answers', () => {
    expect(isTextField('board_card', 'title')).toBe(true);
    expect(isTextField('board_card', 'feedback')).toBe(false);
    expect(isTextField('plan_turn', 'answers.q1')).toBe(true);
    expect(isTextField('plan', 'answers.q1')).toBe(false);
    expect(isTextField('plan_turn', 'answers.')).toBe(false);
  });
});

describe('textOfflineBackoffMs', () => {
  it('doubles from one minute up to thirty', () => {
    expect(textOfflineBackoffMs(0)).toBe(60_000);
    expect(textOfflineBackoffMs(1)).toBe(120_000);
    expect(textOfflineBackoffMs(4)).toBe(16 * 60_000);
    expect(textOfflineBackoffMs(5)).toBe(30 * 60_000);
    expect(textOfflineBackoffMs(500)).toBe(30 * 60_000);
  });
});
