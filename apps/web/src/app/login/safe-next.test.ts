import { describe, expect, test } from 'bun:test';
import { safeNext, signedInRedirect } from './safe-next';

describe('safeNext', () => {
  test('a same-origin path is kept, with its query', () => {
    expect(safeNext('/projects')).toBe('/projects');
    expect(safeNext('/projects?connect=1')).toBe('/projects?connect=1');
    expect(safeNext('/')).toBe('/');
  });

  test('nothing, or not a path, goes home', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('projects')).toBe('/');
  });

  test('no open redirect', () => {
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
    expect(safeNext('/\t/evil.example')).toBe('/');
    expect(safeNext('/\n/evil.example')).toBe('/');
  });

  test('never back to the login page', () => {
    expect(safeNext('/login')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
  });
});

describe('signedInRedirect', () => {
  test('signed out, the form shows', () => {
    expect(signedInRedirect(false, '/projects')).toBeNull();
    expect(signedInRedirect(false, undefined)).toBeNull();
  });

  test('signed in, to next or home', () => {
    expect(signedInRedirect(true, '/admin/runners?add=1')).toBe(
      '/admin/runners?add=1',
    );
    expect(signedInRedirect(true, undefined)).toBe('/');
  });

  test('signed in, an unsafe or repeated next goes home', () => {
    expect(signedInRedirect(true, '//evil.example')).toBe('/');
    expect(signedInRedirect(true, ['/a', '/b'])).toBe('/');
    expect(signedInRedirect(true, '/login')).toBe('/');
  });
});
