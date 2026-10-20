import { describe, expect, it } from 'bun:test';
import { HookSessions } from './sessions';

describe('HookSessions (spec 201 D10, D22)', () => {
  it('maps the nearest claude ancestor, through a shell, to the session', () => {
    const sessions = new HookSessions();
    sessions.started('s-1', '/w/app', [
      { pid: 30, comm: 'sh' },
      { pid: 20, comm: '/usr/local/bin/claude' },
      { pid: 10, comm: 'claude' },
    ]);
    expect(sessions.resolve(20, undefined)).toBe('s-1');
    expect(sessions.resolve(10, undefined)).toBeNull();
  });

  it('falls back to the single live session in the cwd, never to an ambiguous one', () => {
    const sessions = new HookSessions();
    sessions.seen('s-1', '/w/app');
    expect(sessions.resolve(undefined, '/w/app')).toBe('s-1');
    sessions.seen('s-2', '/w/app');
    expect(sessions.resolve(undefined, '/w/app')).toBeNull();
    sessions.ended('s-2');
    expect(sessions.resolve(undefined, '/w/app')).toBe('s-1');
  });

  it('forgets the pid of an ended session but keeps its cwd for OTLP', () => {
    const sessions = new HookSessions();
    sessions.started('s-1', '/w/app/src', [{ pid: 5, comm: 'claude' }]);
    sessions.ended('s-1');
    expect(sessions.resolve(5, undefined)).toBeNull();
    expect(sessions.projectOf('s-1', [{ id: 'prj', root: '/w/app' }])).toBe(
      'prj',
    );
    expect(sessions.projectOf('nope', [{ id: 'prj', root: '/w/app' }])).toBe(
      undefined,
    );
  });

  it('evicts the least recently seen session past its cap', () => {
    const sessions = new HookSessions(2);
    sessions.started('a', '/a', [{ pid: 1_001, comm: 'claude' }]);
    sessions.seen('b', '/b');
    sessions.seen('a', '/a');
    sessions.seen('c', '/c');
    expect(sessions.size).toBe(2);
    expect(sessions.cwdOf('b')).toBeUndefined();
    expect(sessions.resolve(1_001, undefined)).toBe('a');
  });

  it('keeps the manual tmux session a SessionStart reported', () => {
    const sessions = new HookSessions();
    sessions.started('m', '/w/app', [], 'nautelle-manual-0a1b2c3d');
    expect(sessions.manualOf('m')).toEqual({
      tmuxSession: 'nautelle-manual-0a1b2c3d',
      cwd: '/w/app',
    });
    sessions.started('plain', '/w/app', []);
    expect(sessions.manualOf('plain')).toBeUndefined();
    sessions.ended('m');
    expect(sessions.manualOf('m')).toBeUndefined();
  });
});
