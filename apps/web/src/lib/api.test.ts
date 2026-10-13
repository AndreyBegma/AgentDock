import { describe, expect, mock, test } from 'bun:test';
import { AUTH_ERROR } from '@agentdock/shared';
import {
  ApiError,
  describeError,
  describeErrorHint,
  errorText,
  errorToastOptions,
  toErrorHint,
} from './api';

describe('error hints', () => {
  test('a plain sentence becomes a hint with no fix', () => {
    expect(toErrorHint('Nope.')).toEqual({ text: 'Nope.' });
    expect(errorText('Nope.')).toBe('Nope.');
  });

  test('a hint passes through', () => {
    const hint = {
      text: 'Runner offline.',
      href: '/admin/runners',
      cta: 'Open Runners',
    };
    expect(toErrorHint(hint)).toBe(hint);
    expect(errorText(hint)).toBe('Runner offline.');
  });

  test('a toast gets an action that navigates to the fix', () => {
    const navigate = mock((_href: string) => {});
    const options = errorToastOptions(
      { text: 'Runner offline.', href: '/admin/runners', cta: 'Open Runners' },
      navigate,
    );
    expect(options.action?.label).toBe('Open Runners');
    options.action?.onClick();
    expect(navigate).toHaveBeenCalledWith('/admin/runners');
  });

  test('a toast without a fix has no action', () => {
    const navigate = mock((_href: string) => {});
    expect(errorToastOptions('Nope.', navigate)).toEqual({});
    expect(errorToastOptions({ text: 'Nope.', href: '/x' }, navigate)).toEqual(
      {},
    );
  });

  test('describeError stays a string, and the hint carries the same text', () => {
    const error = new ApiError(429, undefined, 'Too Many Requests');
    expect(describeError(error)).toBe(
      'Too many attempts. Wait a minute and try again.',
    );
    expect(describeErrorHint(error)).toEqual({
      text: 'Too many attempts. Wait a minute and try again.',
    });
    expect(describeErrorHint(new Error('boom'))).toEqual({
      text: 'Could not reach the server.',
    });
  });

  test('a forbidden error links back to the Overview', () => {
    const error = new ApiError(403, AUTH_ERROR.forbidden, 'Forbidden');
    expect(describeErrorHint(error)).toEqual({
      text: 'You do not have access to this.',
      href: '/',
      cta: 'Go to Overview',
    });
  });
});
