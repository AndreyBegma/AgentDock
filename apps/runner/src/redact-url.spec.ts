import { describe, expect, it } from 'bun:test';
import { errorMessage } from './log';
import { redactUrlUserinfo, stripUrlCredentials } from './redact-url';

describe('redactUrlUserinfo', () => {
  it('masks the userinfo of every URL in a message', () => {
    expect(
      redactUrlUserinfo(
        'fatal: unable to access https://user:ghp_secret@github.com/o/r.git/ and ssh://git@host/x',
      ),
    ).toBe(
      'fatal: unable to access https://***@github.com/o/r.git/ and ssh://***@host/x',
    );
  });

  it('leaves SSH-style and credential-free URLs alone', () => {
    const text = 'git@github.com:o/r.git https://github.com/o/r.git a@b';
    expect(redactUrlUserinfo(text)).toBe(text);
  });

  it('is applied to error messages', () => {
    expect(
      errorMessage(new Error('clone https://x:tok@github.com/o/r failed')),
    ).toBe('clone https://***@github.com/o/r failed');
  });
});

describe('stripUrlCredentials', () => {
  it('drops userinfo, query and fragment', () => {
    expect(
      stripUrlCredentials('https://user:tok@github.com/o/r.git?a=b#c'),
    ).toEqual({ url: 'https://github.com/o/r.git', stripped: true });
  });

  it('reports SSH-style and clean origins unchanged', () => {
    for (const url of ['git@github.com:o/r.git', 'https://github.com/o/r.git'])
      expect(stripUrlCredentials(url)).toEqual({ url, stripped: false });
  });
});
