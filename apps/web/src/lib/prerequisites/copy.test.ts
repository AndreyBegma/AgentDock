import { describe, expect, test } from 'bun:test';
import {
  ENCRYPTION_KEY_REMEDY,
  PUBLIC_URL_REMEDY,
  runnerOfflineCopy,
  serverEnvRemedy,
  watchRefusalCopy,
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

describe('watchRefusalCopy (#691)', () => {
  const REFUSED =
    "refused by this runner's policy (allowedRoots): this runner allows no project root yet. On the runner's machine: `agentdock-runner policy allow-root /srv/dev/widget`";

  test('no banner while the runner watches the project', () => {
    expect(
      watchRefusalCopy({
        runnerName: 'laptop',
        runnerStatus: 'online',
        watchRefusal: null,
      }),
    ).toBeNull();
    expect(
      watchRefusalCopy({ runnerName: 'laptop', runnerStatus: 'online' }),
    ).toBeNull();
  });

  test('an offline runner has its own banner', () => {
    expect(
      watchRefusalCopy({
        runnerName: 'laptop',
        runnerStatus: 'offline',
        watchRefusal: REFUSED,
      }),
    ).toBeNull();
  });

  test('says the runner refuses the project, why, and the exact command', () => {
    expect(
      watchRefusalCopy({
        runnerName: 'laptop',
        runnerStatus: 'online',
        watchRefusal: REFUSED,
      }),
    ).toEqual({
      tone: 'danger',
      title: 'Runner laptop refuses to watch this project.',
      body: "This runner allows no project root yet. The Board, card collect and the Planner stop for this project until its folder is allowed. Only the person on the runner's machine can allow it: run this there.",
      commands: [
        'agentdock-runner policy allow-root /srv/dev/widget',
        'agentdock-runner policy allow-root --watched',
      ],
    });
  });

  test('a refusal no allow-root lifts offers no --watched', () => {
    const copy = watchRefusalCopy({
      runnerName: 'laptop',
      runnerStatus: 'online',
      watchRefusal:
        "refused by this runner's policy (allowedRoots): /srv/dev/widget is not a git main checkout. On the runner's machine: `agentdock-runner policy allow-root <dir>`",
    });
    expect(copy?.commands).toEqual([
      'agentdock-runner policy allow-root <dir>',
    ]);
  });

  test('text the runner did not word as a refusal is shown as it is', () => {
    expect(
      watchRefusalCopy({
        runnerName: 'laptop',
        runnerStatus: 'online',
        watchRefusal: 'something else',
      })?.body,
    ).toStartWith('something else.');
  });
});
