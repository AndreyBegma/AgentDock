import { describe, expect, it } from 'bun:test';
import { HOOK_CONTENT_MAX_CHARS } from '@agentdock/shared/protocol';
import { MASK } from '../pane/redact';
import { redactText, toHookContent } from './redact';

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
