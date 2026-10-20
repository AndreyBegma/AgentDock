import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import { confirmUnlanded, notLandedReason } from './accept';

/** #709: Completed means landed — Accept of unlanded work is confirmed. */
describe('Accept of work not in the base (#709)', () => {
  const refusal = new ApiError(
    409,
    'not_landed' as never,
    'C-7’s pull request #77 into develop has not merged, so its work is not in develop yet',
  );

  test('a not_landed refusal yields the sentence naming the missing landing', () => {
    expect(notLandedReason(refusal)).toBe(
      'C-7’s pull request #77 into develop has not merged, so its work is not in develop yet',
    );
  });

  test('any other error is shown as before', () => {
    expect(
      notLandedReason(new ApiError(409, 'merge_failed' as never, 'refused')),
    ).toBeNull();
    expect(notLandedReason(new Error('offline'))).toBeNull();
  });

  test('the confirmed Accept is the same request with confirmUnlanded', () => {
    expect(confirmUnlanded({})).toEqual({ confirmUnlanded: true });
    expect(
      confirmUnlanded({ closePr: { deleteBranch: true, closeIssue: false } }),
    ).toEqual({
      closePr: { deleteBranch: true, closeIssue: false },
      confirmUnlanded: true,
    });
  });
});
