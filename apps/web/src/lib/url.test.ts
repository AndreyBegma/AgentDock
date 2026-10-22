import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { externalHttpsUrl, GITHUB_HOSTS, githubUrl, internalHref } from './url';

describe('internalHref', () => {
  test('keeps an in-app path with its query and fragment', () => {
    expect(internalHref('/projects/p1')).toBe('/projects/p1');
    expect(internalHref('/projects/p1/fleet?open=2&focus=2#log')).toBe(
      '/projects/p1/fleet?open=2&focus=2#log',
    );
  });

  test('refuses a backslash, which a browser reads as a slash', () => {
    expect(internalHref('/\\evil.example')).toBeUndefined();
    expect(internalHref('/\\t/evil.example')).toBeUndefined();
    expect(internalHref('\\\\evil.example')).toBeUndefined();
    expect(internalHref('/%5Cevil.example')).toBeUndefined();
    expect(internalHref('/%5c%09/evil.example')).toBeUndefined();
  });

  test('refuses control characters the URL parser would drop', () => {
    expect(internalHref('/\t/evil.example')).toBeUndefined();
    expect(internalHref('/\n/evil.example')).toBeUndefined();
    expect(internalHref('/projects\u0000')).toBeUndefined();
  });

  test('refuses anything that leaves the origin', () => {
    expect(internalHref('//evil.example')).toBeUndefined();
    expect(internalHref('https://evil.example/x')).toBeUndefined();
    expect(internalHref('javascript:alert(1)')).toBeUndefined();
    expect(internalHref('')).toBeUndefined();
    expect(internalHref(null)).toBeUndefined();
  });
});

describe('externalHttpsUrl', () => {
  test('https only', () => {
    expect(externalHttpsUrl('https://ci.example/run/1')).toBe(
      'https://ci.example/run/1',
    );
    expect(externalHttpsUrl('http://ci.example/run/1')).toBeNull();
    expect(externalHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(externalHttpsUrl('not a url')).toBeNull();
    expect(externalHttpsUrl(null)).toBeNull();
  });

  test('refuses userinfo that disguises the host', () => {
    expect(externalHttpsUrl('https://github.com@evil.example/x')).toBeNull();
  });

  test('the host must match exactly', () => {
    const hosts = GITHUB_HOSTS;
    expect(externalHttpsUrl('https://github.com/o/r/pull/1', { hosts })).toBe(
      'https://github.com/o/r/pull/1',
    );
    expect(
      externalHttpsUrl('https://github.com.evil.example/x', { hosts }),
    ).toBeNull();
    expect(externalHttpsUrl('https://evilgithub.com/x', { hosts })).toBeNull();
    expect(externalHttpsUrl('https://api.github.com/x', { hosts })).toBeNull();
  });

  test('githubUrl is the GitHub host list', () => {
    expect(githubUrl('https://github.com/o/r/issues/7')).toBe(
      'https://github.com/o/r/issues/7',
    );
    expect(githubUrl('https://github.com.evil.example/x')).toBeNull();
    expect(githubUrl('http://github.com/o/r')).toBeNull();
  });
});

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

test('no local copy of the URL check remains (spec 164)', () => {
  const root = join(import.meta.dir, '..');
  const copies = sources(root).filter(
    (path) =>
      path !== import.meta.path &&
      /(function|const) safeHttpsUrl\b/.test(readFileSync(path, 'utf8')),
  );
  expect(copies).toEqual([]);
});
