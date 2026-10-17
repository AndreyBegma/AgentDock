import { describe, expect, it } from 'bun:test';
import { MASK, redact, redactText } from './redact';

describe('redact', () => {
  const one = (text: string) => redact([text])[0];

  it('masks a GitHub token: ghp_ and 36 characters', () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    expect(one(`gh auth ${token} # done`)).toBe(`gh auth ${MASK} # done`);
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

describe('redactText — one redactor for every channel (C-128)', () => {
  const cases: readonly [name: string, input: string, secret: string][] = [
    ['ghp_', `push ${`ghp_${'a1B2'.repeat(9)}`} now`, 'a1B2a1B2'],
    ['github_pat_', `pat github_pat_11ABCDEFG0${'x'.repeat(40)} ok`, 'xxxxxxxx'],
    ['glpat-', 'token glpat-AbCdEfGhIjKlMnOpQrSt12 ok', 'AbCdEfGh'],
    ['sk_live_', 'stripe sk_live_51HabcdefGHIJKLmnop ok', 'abcdefGH'],
    ['sk-', 'key sk-ant-api03-abcdefghijklmnopqrstuv end', 'abcdefghij'],
    ['AIza', 'maps AIzaSy0123456789abcdefghijklmnopqrstuvw ok', 'Sy012345'],
    [
      'JWT',
      'got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw ok',
      'SflKxwRJ',
    ],
    ['xoxb-', 'slack xoxb-123456789012-abcdefghij ok', 'abcdefghij'],
    ['xoxe-', 'refresh xoxe-1-My0xLTIzNDU2Nzg5 ok', 'My0xLTIz'],
    ['xoxe.xoxp-', 'rotate xoxe.xoxp-1-Mi0yLTEyMzQ1Njc ok', 'Mi0yLTEy'],
    ['AKIA', 'aws AKIAIOSFODNN7EXAMPLE ok', 'IOSFODNN'],
    ['secret assignment', 'run with API_KEY=abc123secret now', 'abc123secret'],
    ['DATABASE_URL assignment', '$ DATABASE_URL=mysql://h/db?pw=x1 app', 'pw=x1'],
    ['.env line', 'STRIPE_WEBHOOK=whsec_abcdef', 'whsec_abcdef'],
    ['added .env line in a diff', '+REDIS=redis-secret-host', 'redis-secret'],
    [
      'escaped .env line',
      JSON.stringify({ content: 'A=1\nFOO=topsecretvalue' }),
      'topsecretvalue',
    ],
    [
      'Authorization header',
      'curl -H "Authorization: Bearer abc.def.ghi" https://x',
      'abc.def.ghi',
    ],
    ['Authorization basic', 'authorization: Basic dXNlcjpwdw==', 'dXNlcjpwdw'],
    ['JSON member', '{"client_secret":"hunter2","user":"me"}', 'hunter2'],
    ['JSON api_key member', '{ "api-key": "k-12345" }', 'k-12345'],
    [
      'URL userinfo',
      'cloning https://bot:s3cr3tpw@git.example.com/o/r.git',
      's3cr3tpw',
    ],
    ['URL userinfo in postgres', 'conn postgres://u:pw1234@h/db', 'pw1234'],
  ];

  it.each(cases)('masks %s', (_name, input, secret) => {
    const out = redactText(input);
    expect(input).toContain(secret);
    expect(out).not.toContain(secret);
  });

  it('masks a private-key block across lines', () => {
    expect(
      redactText('a\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\nb'),
    ).toBe(`a\n${MASK}\n${MASK}\n${MASK}\nb`);
  });

  it('keeps ordinary code readable', () => {
    const text = [
      'const x = compute(a, b);',
      '    total = total + 1',
      '+import { join } from "node:path";',
      ' return x;',
      'see https://github.com/acme/x/pull/1',
    ].join('\n');
    expect(redactText(text)).toBe(text);
  });
});
