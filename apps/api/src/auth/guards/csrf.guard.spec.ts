import { type ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BearerBody, Public } from '../decorators';
import { CsrfGuard } from './csrf.guard';

class Routes {
  @Public()
  json(): void {}

  @Public()
  @BearerBody()
  upload(): void {}
}

const contextOf = (
  handler: keyof Routes,
  headers: Record<string, string>,
): ExecutionContext => {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const request = {
    method: 'POST',
    cookies: {},
    get: (name: string) => lower[name.toLowerCase()],
    is: (type: string) => (lower['content-type'] === type ? type : false),
  } as unknown as Request;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
  } as unknown as ExecutionContext;
};

const statusOf = (guard: CsrfGuard, context: ExecutionContext): number => {
  try {
    guard.canActivate(context);
    return 200;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : 500;
  }
};

describe('CsrfGuard (ADR-0090 @BearerBody)', () => {
  const guard = new CsrfGuard(new Reflector());

  it('lets a @BearerBody route take a raw body with a bearer token', () => {
    expect(
      statusOf(
        guard,
        contextOf('upload', {
          'content-type': 'video/mp4',
          authorization: 'Bearer adr_abc',
        }),
      ),
    ).toBe(200);
  });

  it('still wants JSON from a @BearerBody route without a bearer token', () => {
    expect(
      statusOf(guard, contextOf('upload', { 'content-type': 'video/mp4' })),
    ).toBe(415);
    expect(
      statusOf(
        guard,
        contextOf('upload', {
          'content-type': 'video/mp4',
          authorization: 'Basic abc',
        }),
      ),
    ).toBe(415);
    expect(
      statusOf(
        guard,
        contextOf('upload', {
          'content-type': 'video/mp4',
          authorization: 'Bearer ',
        }),
      ),
    ).toBe(415);
  });

  it('keeps every other public route JSON-only, bearer token or not', () => {
    expect(
      statusOf(
        guard,
        contextOf('json', {
          'content-type': 'video/mp4',
          authorization: 'Bearer adr_abc',
        }),
      ),
    ).toBe(415);
    expect(
      statusOf(
        guard,
        contextOf('json', { 'content-type': 'application/json' }),
      ),
    ).toBe(200);
  });
});
