import { describe, expect, test } from 'bun:test';
import { AUTH_ERROR } from '@agentdock/shared';
import { ApiError } from '../api';
import { miniAppDestination, signInProblem } from './mini-app';

const P = 'cmb1x2y3z0000abcd1234efgh';
const Q = 'cmb9x8y7z0000abcd1234zzzz';

describe('miniAppDestination', () => {
  test("a direct link's start_param wins", () => {
    expect(
      miniAppDestination({
        startParam: `${P}_12`,
        search: `?start=${Q}`,
        projectId: Q,
      }),
    ).toBe(`/projects/${P}/board?card=12`);
  });

  test("a Web App button's ?start= opens its card", () => {
    expect(
      miniAppDestination({
        startParam: undefined,
        search: `?start=${P}_3`,
        projectId: Q,
      }),
    ).toBe(`/projects/${P}/board?card=3`);
  });

  test("then the chat's last project, then home", () => {
    expect(
      miniAppDestination({ startParam: undefined, search: '', projectId: Q }),
    ).toBe(`/projects/${Q}/board`);
    expect(
      miniAppDestination({
        startParam: 'bad/param',
        search: '',
        projectId: null,
      }),
    ).toBe('/');
  });
});

describe('signInProblem', () => {
  test('names the unlinked and expired refusals', () => {
    expect(
      signInProblem(new ApiError(403, AUTH_ERROR.telegramNotLinked, 'x')),
    ).toEqual({ kind: 'not_linked' });
    expect(
      signInProblem(new ApiError(401, AUTH_ERROR.telegramExpired, 'x')),
    ).toEqual({ kind: 'expired' });
  });

  test('passes any other failure on with its message', () => {
    const problem = signInProblem(
      new ApiError(401, AUTH_ERROR.telegramInvalid, 'Telegram did not sign'),
    );
    expect(problem.kind).toBe('failed');
  });
});
