import { BadRequestException } from '@nestjs/common';
import {
  PositiveBigIntPipe,
  PositiveIntPipe,
  parsePositiveBigInt,
  parsePositiveInt,
} from './bounded-id.pipe';

const param = { type: 'param', data: 'id' } as const;

describe('parsePositiveInt', () => {
  it('accepts 1..2^31-1', () => {
    expect(parsePositiveInt('1')).toBe(1);
    expect(parsePositiveInt('2147483647')).toBe(2147483647);
  });

  it.each([
    '0',
    '2147483648',
    '99999999999',
    '-1',
    '01',
    '1.5',
    '1e3',
    '',
  ])('refuses %p', (raw) => expect(parsePositiveInt(raw)).toBeNull());
});

describe('parsePositiveBigInt', () => {
  it('accepts 1..2^63-1', () => {
    expect(parsePositiveBigInt('1')).toBe(1n);
    expect(parsePositiveBigInt('9223372036854775807')).toBe(
      9223372036854775807n,
    );
  });

  it.each([
    '0',
    '9223372036854775808',
    '99999999999999999999',
    '-1',
    'abc',
  ])('refuses %p', (raw) => expect(parsePositiveBigInt(raw)).toBeNull());
});

describe('the pipes', () => {
  it('answer 400 out of range', () => {
    expect(() => new PositiveIntPipe().transform('99999999999', param)).toThrow(
      BadRequestException,
    );
    expect(() =>
      new PositiveBigIntPipe().transform('99999999999999999999', param),
    ).toThrow(BadRequestException);
  });

  it('pass a value in range through as a number or a BigInt', () => {
    expect(new PositiveIntPipe().transform('42', param)).toBe(42);
    expect(new PositiveBigIntPipe().transform('42', param)).toBe(42n);
  });
});
