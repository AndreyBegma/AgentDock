import { describe, expect, it } from 'bun:test';
import { MASK, redact } from './redact';

describe('redact', () => {
  const one = (text: string) => redact([text])[0];

  it('masks a GitHub token: ghp_ and 36 characters', () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    expect(one(`export GH=${token} # done`)).toBe(`export GH=${MASK} # done`);
  });

  it('masks the other GitHub token prefixes', () => {
    expect(one(`gho_${'x'.repeat(36)}`)).toBe(MASK);
    expect(one(`ghs_${'x'.repeat(36)}`)).toBe(MASK);
  });

  it('masks sk- keys', () => {
    expect(one('key sk-ant-api03-abcdefghijklmnopqrstuv end')).toBe(
      `key ${MASK} end`,
    );
  });

  it('masks xox Slack tokens', () => {
    expect(one('SLACK=xoxb-123456789012-abcdefghij')).toBe(`SLACK=${MASK}`);
  });

  it('masks AWS access key ids', () => {
    expect(one('id AKIAIOSFODNN7EXAMPLE!')).toBe(`id ${MASK}!`);
  });

  it('masks a private key block across lines', () => {
    const lines = [
      'before',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      'qwertyuiop',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ];
    expect(redact(lines)).toEqual(['before', MASK, MASK, MASK, MASK, 'after']);
  });

  it('masks a private key block on one line', () => {
    expect(
      one('-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY----- tail'),
    ).toBe(`${MASK} tail`);
  });

  it('masks an unterminated key block to the end of the capture', () => {
    expect(
      redact(['-----BEGIN OPENSSH PRIVATE KEY-----', 'secret', 'more']),
    ).toEqual([MASK, MASK, MASK]);
  });

  it('leaves ordinary text and ANSI colour alone', () => {
    const text = '\x1b[32mok\x1b[0m skeleton ghp_short AKIA123';
    expect(one(text)).toBe(text);
  });
});
