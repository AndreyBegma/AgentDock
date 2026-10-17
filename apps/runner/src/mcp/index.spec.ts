import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { saveSessionToken, sessionTokenDir } from '../local/session-tokens';
import { tempDir } from '../testing/fixtures';
import { mcpSessionToken } from './index';

describe('mcpSessionToken (#113)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('takes a launched session’s token from the env, else the one kept for its claude', () => {
    const socketPath = join(dir, 'runner.sock');
    expect(mcpSessionToken({ env: {}, socketPath, ppid: 300 })).toBeUndefined();
    saveSessionToken(
      sessionTokenDir(socketPath),
      { sessionId: 's-1', claudePid: 300 },
      'tok-kept',
    );
    expect(mcpSessionToken({ env: {}, socketPath, ppid: 300 })).toBe(
      'tok-kept',
    );
    expect(mcpSessionToken({ env: {}, socketPath, ppid: 301 })).toBeUndefined();
    expect(
      mcpSessionToken({
        env: { AGENTDOCK_SESSION_TOKEN: 'tok-env' },
        socketPath,
        ppid: 300,
      }),
    ).toBe('tok-env');
  });
});
