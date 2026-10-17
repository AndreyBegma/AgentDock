import { REDACTED_SECRET, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('replaces the given secret wherever it appears', () => {
    expect(redactSecrets('a plainkey123 b plainkey123', ['plainkey123'])).toBe(
      `a ${REDACTED_SECRET} b ${REDACTED_SECRET}`,
    );
  });

  it.each([
    ['sk-ant-api03-AbCdEf123456'],
    ['sk-proj-AbCdEf123456'],
    ['sk-or-v1-AbCdEf123456'],
    ['xai-AbCdEf123456'],
  ])('redacts a key shaped like %s without being told it', (key) => {
    expect(redactSecrets(`invalid key ${key}.`)).toBe(
      `invalid key ${REDACTED_SECRET}.`,
    );
  });

  it('redacts bearer tokens and x-api-key values, keeping the label', () => {
    expect(redactSecrets('Authorization: Bearer abcdefgh12345')).toBe(
      `Authorization: Bearer ${REDACTED_SECRET}`,
    );
    expect(redactSecrets('{"x-api-key":"whatever-1234"}')).toBe(
      `{"x-api-key":"${REDACTED_SECRET}"}`,
    );
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('rate limited (429)')).toBe('rate limited (429)');
  });
});
