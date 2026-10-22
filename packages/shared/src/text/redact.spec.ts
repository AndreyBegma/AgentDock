import { describe, expect, it } from 'bun:test';
import { REDACTION_MARKER, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('drops URL userinfo and marks the URL', () => {
    expect(
      redactSecrets(
        "fatal: unable to access 'https://user:tok@github.com/o/r/': 403",
      ),
    ).toBe(
      `fatal: unable to access 'https://github.com/o/r/ ${REDACTION_MARKER}': 403`,
    );
    expect(
      redactSecrets('push to https://x-access-token:abc@github.com/o/r.'),
    ).toBe(`push to https://github.com/o/r ${REDACTION_MARKER}.`);
  });

  it('redacts secret query parameters and token shapes', () => {
    const ghp = `ghp_${'a'.repeat(36)}`;
    const pat = `github_pat_${'B1_'.repeat(10)}`;
    const text = [
      'GET https://api.example.com/x?access_token=s3cr3t&page=2',
      `token ${ghp}`,
      `pat ${pat}`,
      `glpat-${'c'.repeat(20)}`,
      'AKIAABCDEFGHIJKLMNOP',
      `sk-${'d'.repeat(20)}`,
      'Authorization: Bearer abc.def.ghi-jkl',
      'x-api-key: k3y-value',
    ].join('\n');
    const out = redactSecrets(text);
    for (const secret of [
      's3cr3t',
      ghp,
      pat,
      'glpat-',
      'AKIAABCDEFGHIJKLMNOP',
      'sk-d',
      'abc.def.ghi-jkl',
      'k3y-value',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(`access_token=${REDACTION_MARKER}&page=2`);
    expect(out).toContain(`Bearer ${REDACTION_MARKER}`);
  });

  it('keeps local paths, SSH remotes and plain text', () => {
    const text =
      "error: pathspec 'main' did not match; repo /home/me/src/app; remote git@github.com:o/r.git; the token expired";
    expect(redactSecrets(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets(
      'https://u:p@github.com/o/r ?token=abc Bearer abcdefghij',
    );
    expect(redactSecrets(once)).toBe(once);
  });
});
