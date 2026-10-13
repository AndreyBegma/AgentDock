import { describe, expect, test } from 'bun:test';
import {
  isLocalUrl,
  keepOnlineCommands,
  pairingServers,
  platformOf,
  serverOfCommand,
} from './install';

describe('platformOf', () => {
  test("the runner's own os wins over the browser", () => {
    expect(platformOf('darwin', 'X11; Linux x86_64')).toBe('macos');
    expect(platformOf('linux', 'Macintosh; Intel Mac OS X')).toBe('linux');
    expect(platformOf('win32', 'Macintosh')).toBe('unknown');
  });

  test('without one, the browser is the guess', () => {
    expect(
      platformOf(null, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'),
    ).toBe('macos');
    expect(platformOf(null, 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(platformOf(null, 'Mozilla/5.0 (Linux; Android 14)')).toBe('unknown');
    expect(platformOf(undefined)).toBe('unknown');
  });
});

describe('keepOnlineCommands', () => {
  test('install-service is Linux only; macOS uses brew services', () => {
    expect(keepOnlineCommands('linux')).toEqual([
      'agentdock-runner install-service',
    ]);
    expect(keepOnlineCommands('macos')).toEqual([
      'brew services start agentdock-runner',
    ]);
    expect(keepOnlineCommands('unknown')).toHaveLength(2);
  });
});

describe('pairing servers', () => {
  const command = (server: string) =>
    `agentdock-runner pair --server ${server} --code ABCD-EFGH`;

  test('reads the --server value', () => {
    expect(serverOfCommand(command('https://api.x.dev'))).toBe(
      'https://api.x.dev',
    );
    expect(serverOfCommand('agentdock-runner pair')).toBeNull();
  });

  test('local hosts', () => {
    expect(isLocalUrl('http://localhost:8180')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1')).toBe(true);
    expect(isLocalUrl('https://agentdock.example.com')).toBe(false);
    expect(isLocalUrl('not a url')).toBe(false);
  });

  test("the page's origin is the server; the same API_URL adds nothing", () => {
    expect(
      pairingServers(
        'https://dock.example.com',
        command('https://dock.example.com/api'),
      ),
    ).toEqual({ primary: 'https://dock.example.com/api', alternative: null });
  });

  test('a different, public API_URL is shown as an alternative', () => {
    expect(
      pairingServers(
        'https://dock.example.com/',
        command('https://api.example.com'),
      ),
    ).toEqual({
      primary: 'https://dock.example.com/api',
      alternative: 'https://api.example.com',
    });
  });

  test('a localhost API_URL is hidden behind a public page', () => {
    expect(
      pairingServers(
        'https://dock.example.com',
        command('http://localhost:8180'),
      ),
    ).toEqual({ primary: 'https://dock.example.com/api', alternative: null });
  });

  test("on a localhost page the API's own URL comes first", () => {
    expect(
      pairingServers('http://localhost:3517', command('http://localhost:8180')),
    ).toEqual({
      primary: 'http://localhost:8180',
      alternative: 'http://localhost:3517/api',
    });
  });
});
