import { describe, expect, it } from 'bun:test';
import { SESSION_MESSAGE_MAX_CHARS } from '@nautelle/shared';
import { ApiError } from '../api';
import { draftProblem, sessionMessageError } from './format';

describe('draftProblem (#489)', () => {
  it('is empty when only control characters or spaces are left', () => {
    expect(draftProblem('')).toBe('empty');
    expect(draftProblem('  \n\t')).toBe('empty');
    expect(draftProblem('\u001b[A\u0003')).toBe('empty');
    expect(draftProblem('go on')).toBeNull();
  });

  it('is too long over the cap', () => {
    expect(draftProblem('x'.repeat(SESSION_MESSAGE_MAX_CHARS))).toBeNull();
    expect(draftProblem('x'.repeat(SESSION_MESSAGE_MAX_CHARS + 1))).toBe(
      'too_long',
    );
  });
});

describe('sessionMessageError', () => {
  it('says what a refusal means', () => {
    expect(
      sessionMessageError(new ApiError(403, undefined, 'Forbidden', undefined)),
    ).toBe('Messaging a session needs the operator role.');
    expect(
      sessionMessageError(
        new ApiError(503, undefined, 'x', undefined, {
          error: 'command_unavailable',
        }),
      ),
    ).toContain('runner is offline');
    expect(sessionMessageError(new Error('boom'))).toBe('boom');
  });
});
