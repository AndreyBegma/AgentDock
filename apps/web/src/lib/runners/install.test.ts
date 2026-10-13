import { describe, expect, test } from 'bun:test';
import {
  INSTALL_COMMANDS,
  isLocalUrl,
  KEEP_ONLINE_COMMANDS,
  pairingServers,
  serverOfCommand,
} from './install';

describe('install and keep-online commands', () => {
  test('one keep-online command per install method, in the same order', () => {
    expect(INSTALL_COMMANDS.map((item) => item.label)).toEqual([
      'Homebrew',
      'npm',
    ]);
    expect(KEEP_ONLINE_COMMANDS.map((item) => item.command)).toEqual([
      'brew services start agentdock-runner',
      'agentdock-runner install-service',
    ]);
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
