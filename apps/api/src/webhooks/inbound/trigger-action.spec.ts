import { HttpException } from '@nestjs/common';
import { checkTemplate } from './trigger-action';

const orchestrator = { kind: 'orchestrator', mode: 'next' } as const;

const statusOf = (valuePattern: string | null): number | null => {
  try {
    checkTemplate(orchestrator, [], valuePattern);
    return null;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
};

describe('checkTemplate valuePattern', () => {
  it('refuses a nested quantifier with 422', () => {
    expect(statusOf('^(a+)+$')).toBe(422);
  });

  it('refuses a pattern over 200 characters and one that does not compile', () => {
    expect(statusOf('a'.repeat(201))).toBe(422);
    expect(statusOf('([')).toBe(422);
  });

  it('accepts none and a plain pattern', () => {
    expect(statusOf(null)).toBeNull();
    expect(statusOf('^[\\w.:/#@+-]{1,100}$')).toBeNull();
  });
});
