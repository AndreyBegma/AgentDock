import { describe, expect, test } from 'bun:test';
import {
  ENCRYPTION_KEY_REMEDY,
  PUBLIC_URL_REMEDY,
  runnerOfflineCopy,
  serverEnvRemedy,
} from './copy';

describe('serverEnvRemedy', () => {
  test('names the variable, an example, where it goes, and the restart', () => {
    expect(
      serverEnvRemedy({ variable: 'PUBLIC_URL', example: 'https://x.dev' }),
    ).toBe(
      "Set PUBLIC_URL in the API's environment, e.g. PUBLIC_URL=https://x.dev. Then restart the API.",
    );
  });

  test('the encryption key says how to generate one', () => {
    expect(ENCRYPTION_KEY_REMEDY).toContain('APP_ENCRYPTION_KEY');
    expect(ENCRYPTION_KEY_REMEDY).toContain('openssl rand -base64 32');
    expect(ENCRYPTION_KEY_REMEDY).toContain('restart the API');
    expect(PUBLIC_URL_REMEDY).toContain('PUBLIC_URL=https://');
  });
});

describe('runnerOfflineCopy', () => {
  test('no banner while the runner is online', () => {
    expect(
      runnerOfflineCopy({ runnerName: 'laptop', runnerStatus: 'online' }, true),
    ).toBeNull();
  });

  test('an admin gets the issue wording and a link to Runners', () => {
    expect(
      runnerOfflineCopy(
        { runnerName: 'laptop', runnerStatus: 'offline' },
        true,
      ),
    ).toEqual({
      tone: 'warn',
      title: 'Runner laptop is offline.',
      body: "Nothing on this page can reach the project's machine until it reconnects.",
      href: '/admin/runners',
      cta: 'Open Runners',
    });
  });

  test('a stale runner reads as offline', () => {
    expect(
      runnerOfflineCopy({ runnerName: 'laptop', runnerStatus: 'stale' }, true)
        ?.title,
    ).toBe('Runner laptop is offline.');
  });

  test('a non-admin gets no link and is told to ask an administrator', () => {
    const copy = runnerOfflineCopy(
      { runnerName: 'laptop', runnerStatus: 'offline' },
      false,
    );
    expect(copy?.href).toBeUndefined();
    expect(copy?.cta).toBeUndefined();
    expect(copy?.body).toContain('Ask an administrator');
  });

  test('a revoked runner says so', () => {
    expect(
      runnerOfflineCopy(
        { runnerName: 'laptop', runnerStatus: 'revoked' },
        true,
      ),
    ).toMatchObject({ tone: 'danger', title: 'Runner laptop was revoked.' });
  });
});
