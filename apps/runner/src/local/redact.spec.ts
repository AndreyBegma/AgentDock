import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HOOK_CONTENT_MAX_CHARS } from '@nautelle/shared/protocol';
import { MASK } from '../pane/redact';
import { redactText, toHookContent, toToolInputPreview } from './redact';

const GHP = `ghp_${'a'.repeat(36)}`;
const KEY_BLOCK = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'c2VjcmV0LWtleS1ib2R5',
  '-----END PRIVATE KEY-----',
].join('\n');

describe('redactText (ADR-0021 §4)', () => {
  it('masks the pane token shapes', () => {
    expect(redactText(`token ${GHP} here`)).toBe(`token ${MASK} here`);
  });

  it('masks a multi-line private-key block, markers included', () => {
    const out = redactText(`before\n${KEY_BLOCK}\nafter`);
    expect(out).not.toContain('MIIEvQ');
    expect(out).not.toContain('BEGIN PRIVATE KEY');
    expect(out.startsWith('before\n')).toBe(true);
    expect(out.endsWith('\nafter')).toBe(true);
  });

  it('masks a key block inside JSON-escaped tool input', () => {
    const json = JSON.stringify({ content: KEY_BLOCK });
    const out = redactText(json);
    expect(out).not.toContain('MIIEvQ');
    expect(out).not.toContain('c2VjcmV0');
  });

  it('masks .env assignments, plain and escaped', () => {
    expect(redactText('DATABASE_URL=postgres://u:p@h/db\nexport FOO=bar')).toBe(
      `DATABASE_URL=${MASK}\nexport FOO=${MASK}`,
    );
    const escaped = JSON.stringify({ content: 'A=1\nSTRIPE_SECRET=sk_live_x' });
    const out = redactText(escaped);
    expect(out).not.toContain('sk_live_x');
  });

  it('masks secret-named assignments and JSON members', () => {
    expect(redactText('run with API_KEY=abc123 now')).toBe(
      `run with API_KEY=${MASK} now`,
    );
    expect(redactText('{"password":"hunter2","user":"me"}')).toBe(
      `{"password":"${MASK}","user":"me"}`,
    );
  });

  it('masks Authorization headers', () => {
    expect(
      redactText('curl -H "Authorization: Bearer abc.def.ghi" https://x'),
    ).toBe(`curl -H "Authorization: Bearer ${MASK}" https://x`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'const x = compute(a, b);\nreturn x;';
    expect(redactText(text)).toBe(text);
  });
});

describe('toHookContent', () => {
  it('caps at HOOK_CONTENT_MAX_CHARS and marks truncated', () => {
    const content = toHookContent('x'.repeat(20 * 1024));
    expect(content.text).toHaveLength(HOOK_CONTENT_MAX_CHARS);
    expect(content.truncated).toBe(true);
  });

  it('keeps a short text whole', () => {
    expect(toHookContent('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('keeps the truncated mark of a text the hook already cut', () => {
    expect(toHookContent('hello', true)).toEqual({
      text: 'hello',
      truncated: true,
    });
  });

  it('redacts before cutting, so a secret across the cap is masked', () => {
    const text = `${'x'.repeat(HOOK_CONTENT_MAX_CHARS - 10)}${GHP}`;
    const content = toHookContent(text);
    expect(content.text).not.toContain('ghp_aaaa');
  });
});

describe('redactText — bare secret names', () => {
  it('masks a bare TOKEN= or PASSWORD= assignment (C-114)', () => {
    expect(redactText('echo TOKEN=hunter2 && PASSWORD=x ls')).toBe(
      `echo TOKEN=${MASK} && PASSWORD=${MASK} ls`,
    );
  });
});

describe('toToolInputPreview (C-114)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');

  it('keeps a short input whole', () => {
    expect(toToolInputPreview('{"command":"ls"}', 100)).toEqual({
      input: '{"command":"ls"}',
      truncated: false,
      fullLength: 16,
      sha256: sha('{"command":"ls"}'),
    });
  });

  it('keeps head and tail of a long input within the budget', () => {
    const raw = `HEAD${'x'.repeat(5_000)}TAIL`;
    const preview = toToolInputPreview(raw, 200);
    expect(preview.truncated).toBe(true);
    expect(preview.fullLength).toBe(raw.length);
    expect(preview.sha256).toBe(sha(raw));
    expect(preview.input.length).toBeLessThanOrEqual(200);
    expect(preview.input.startsWith('HEAD')).toBe(true);
    expect(preview.input.endsWith('TAIL')).toBe(true);
    const shown = preview.input.replace(
      /\n… \[\d+ characters omitted\] …\n/,
      '',
    );
    const omitted = Number(/\[(\d+) characters/.exec(preview.input)?.[1]);
    expect(shown.length + omitted).toBe(raw.length);
  });

  it('redacts before it hashes and cuts: a secret in the tail is masked', () => {
    const raw = `${'x'.repeat(3_000)} ${GHP}`;
    const preview = toToolInputPreview(raw, 200);
    expect(preview.input).not.toContain('ghp_');
    expect(preview.input.endsWith(MASK)).toBe(true);
    expect(preview.sha256).toBe(sha(redactText(raw)));
    expect(preview.fullLength).toBe(redactText(raw).length);
  });

  it('never splits a surrogate pair at either cut', () => {
    const raw = '😀'.repeat(1_000);
    for (const max of [199, 200, 201, 202]) {
      const { input } = toToolInputPreview(raw, max);
      expect(input.length).toBeLessThanOrEqual(max);
      expect(input).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(input).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
});
