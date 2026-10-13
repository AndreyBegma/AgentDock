import { describe, expect, test } from 'bun:test';
import {
  BUN_INSTALL_COMMAND,
  INSTALL_COMMANDS,
  installGuide,
  isLocalUrl,
  KEEP_ONLINE_COMMANDS,
  PROFILES_DETECT_COMMAND,
  pairingServers,
  RUN_COMMAND,
  serverOfCommand,
  VERSION_COMMAND,
} from './install';

describe('the /install guide', () => {
  const guide = installGuide('https://dock.example.com');

  test('install and keep-online commands are the shared constants', () => {
    expect(guide.install).toEqual([
      ...INSTALL_COMMANDS,
      { label: 'Bun', command: BUN_INSTALL_COMMAND },
    ]);
    expect(guide.keepOnline).toBe(KEEP_ONLINE_COMMANDS);
    expect(guide.run).toBe(RUN_COMMAND);
    expect(guide.version).toBe(VERSION_COMMAND);
    expect(guide.profiles).toBe(PROFILES_DETECT_COMMAND);
  });

  test("pairs with the page's origin plus /api", () => {
    expect(guide.pair).toBe(
      'agentdock-runner pair --server https://dock.example.com/api --code XXXX-XXXX',
    );
    expect(guide.health).toBe('https://dock.example.com/api/health');
    expect(guide.healthCheck).toBe('curl https://dock.example.com/api/health');
    expect(installGuide('https://dock.example.com/').server).toBe(
      'https://dock.example.com/api',
    );
  });

  test('never shows localhost unless the page is on localhost', () => {
    expect(JSON.stringify(guide)).not.toContain('localhost');
    expect(installGuide('http://localhost:3517').pair).toContain(
      'http://localhost:3517/api',
    );
  });
});

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
