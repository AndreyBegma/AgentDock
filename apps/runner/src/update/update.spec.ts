import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../detect/exec';
import { availableVersion, compareVersions, platformPackage } from './check';
import {
  readSkippedVersion,
  startUpdateCheck,
  UPDATE_FILE,
  type UpdateDeps,
} from './index';
import {
  detectInstall,
  installArgv,
  type Manager,
  manualCommand,
} from './install';

const NPM_BINARY =
  '/home/ada/.local/lib/node_modules/nautelle-runner/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner';

type Registry = Record<string, string | Error>;

/** A registry that answers `/<name>/latest` from `versions`, and records each request. */
const fakeRegistry = (versions: Registry) => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const name = url
      .replace('https://registry.npmjs.org/', '')
      .replace(/\/latest$/, '');
    const answer = versions[name];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return new Response('{}', { status: 404 });
    return Response.json({ name, version: answer });
  }) as typeof fetch;
  return { fetch: fetcher, requests };
};

const neverAnswers = (() => new Promise(() => {})) as unknown as typeof fetch;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nautelle-update-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  deps: UpdateDeps;
  stderr: string[];
  asked: string[];
  installs: string[][];
  probes: string[][];
  requests: string[];
}

const harness = (
  overrides: Partial<UpdateDeps> & {
    registry?: Registry;
    answer?: string | null;
    installCode?: number | Error;
    existing?: string[];
    serviceActive?: boolean;
  } = {},
): Harness => {
  const {
    registry = {
      'nautelle-runner': '0.15.0',
      'nautelle-runner-linux-x64': '0.15.0',
    },
    answer = '',
    installCode = 0,
    existing = [NPM_BINARY],
    serviceActive = false,
    ...rest
  } = overrides;
  const stderr: string[] = [];
  const asked: string[] = [];
  const installs: string[][] = [];
  const probes: string[][] = [];
  const { fetch, requests } = fakeRegistry(registry);
  const exec: Exec = async (binary, args) => {
    probes.push([binary, ...args]);
    return { code: serviceActive ? 0 : 3, stdout: '', stderr: '' };
  };
  const deps: UpdateDeps = {
    command: 'status',
    env: {},
    os: 'linux',
    arch: 'x64',
    current: '0.14.0',
    binary: NPM_BINARY,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    fetch,
    ask: (question) => {
      asked.push(question);
      return answer;
    },
    install: async (argv) => {
      installs.push([...argv]);
      if (installCode instanceof Error) throw installCode;
      return installCode;
    },
    exec,
    exists: (path) => existing.includes(path),
    stderr: (text) => {
      stderr.push(text);
    },
    paths: {
      configDir: join(dir, 'nautelle'),
      serviceFile: join(dir, 'nautelle-runner.service'),
      launchAgentFile: join(dir, 'com.nautelle.runner.plist'),
    },
    uid: 501,
    ...rest,
  };
  return { deps, stderr, asked, installs, probes, requests };
};

const run = async (h: Harness): Promise<void> => {
  const check = startUpdateCheck(h.deps);
  expect(check).not.toBeNull();
  await check?.offer();
};

describe('compareVersions', () => {
  it('orders release versions numerically', () => {
    expect(compareVersions('0.15.0', '0.14.0')).toBe(1);
    expect(compareVersions('0.14.0', '0.14.0')).toBe(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
  });

  it('refuses a prerelease', () => {
    expect(compareVersions('0.15.0-beta.1', '0.14.0')).toBeNull();
  });
});

describe('platformPackage', () => {
  it('names the package of a built target, and none for another', () => {
    expect(platformPackage('darwin', 'arm64')).toBe(
      'nautelle-runner-darwin-arm64',
    );
    expect(platformPackage('win32', 'x64')).toBeNull();
  });
});

describe('availableVersion', () => {
  const check = (registry: Registry, current = '0.14.0') =>
    availableVersion({
      fetch: fakeRegistry(registry).fetch,
      current,
      platformPackage: 'nautelle-runner-linux-x64',
    });

  it('offers a newer version both packages have', async () => {
    expect(
      await check({
        'nautelle-runner': '0.15.0',
        'nautelle-runner-linux-x64': '0.15.0',
      }),
    ).toBe('0.15.0');
  });

  it('waits while the platform package is still behind the meta package', async () => {
    expect(
      await check({
        'nautelle-runner': '0.15.0',
        'nautelle-runner-linux-x64': '0.14.0',
      }),
    ).toBeNull();
  });

  it('offers nothing for the same, an older or a prerelease version', async () => {
    const same = { 'nautelle-runner': '0.14.0' };
    expect(
      await check({ ...same, 'nautelle-runner-linux-x64': '0.14.0' }),
    ).toBeNull();
    expect(
      await check(
        {
          'nautelle-runner': '0.13.0',
          'nautelle-runner-linux-x64': '0.13.0',
        },
        '0.14.0',
      ),
    ).toBeNull();
    expect(
      await check({
        'nautelle-runner': '0.15.0-rc.1',
        'nautelle-runner-linux-x64': '0.15.0-rc.1',
      }),
    ).toBeNull();
  });

  it('is null on a network error or a missing package', async () => {
    expect(
      await check({
        'nautelle-runner': new Error('ENOTFOUND'),
        'nautelle-runner-linux-x64': '0.15.0',
      }),
    ).toBeNull();
    expect(await check({ 'nautelle-runner': '0.15.0' })).toBeNull();
  });

  it('gives up after its timeout', async () => {
    const started = Date.now();
    const version = await availableVersion({
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        })) as unknown as typeof fetch,
      current: '0.14.0',
      platformPackage: 'nautelle-runner-linux-x64',
      timeoutMs: 20,
    });
    expect(version).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('detectInstall', () => {
  it.each<[string, Manager]>([
    [NPM_BINARY, 'npm'],
    [
      '/home/ada/.local/share/fnm/node-versions/v22.11.0/installation/lib/node_modules/nautelle-runner/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
      'npm',
    ],
    [
      '/home/ada/.bun/install/global/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
      'bun',
    ],
    [
      '/home/ada/.local/share/pnpm/global/5/node_modules/.pnpm/nautelle-runner-linux-x64@0.14.0/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
      'pnpm',
    ],
    [
      '/home/ada/.config/yarn/global/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
      'yarn',
    ],
  ])('reads the manager from %s', (path, manager) => {
    expect(detectInstall(path)).toEqual({ kind: 'global', manager });
  });

  it.each([
    '/home/ada/.npm/_npx/0f1e2d3c/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
    '/tmp/bunx-1000-nautelle-runner@latest/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
    '/home/ada/.cache/pnpm/dlx/abc123/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
  ])('knows the run cache %s', (path) => {
    expect(detectInstall(path).kind).toBe('ephemeral');
  });

  it('tells Homebrew, a project install and a bare binary apart', () => {
    expect(
      detectInstall('/opt/homebrew/Cellar/nautelle-runner/0.14.0/bin/x'),
    ).toEqual({ kind: 'brew' });
    expect(
      detectInstall(
        '/srv/app/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
      ),
    ).toEqual({ kind: 'unknown' });
    expect(detectInstall('/usr/local/bin/nautelle-runner')).toEqual({
      kind: 'unknown',
    });
  });
});

describe('installArgv', () => {
  it('is each manager’s global install of the version', () => {
    expect(installArgv('npm', '0.15.0')).toEqual([
      'npm',
      'install',
      '-g',
      'nautelle-runner@0.15.0',
    ]);
    expect(installArgv('bun', '0.15.0')).toEqual([
      'bun',
      'add',
      '-g',
      'nautelle-runner@0.15.0',
    ]);
    expect(installArgv('pnpm', '0.15.0')).toEqual([
      'pnpm',
      'add',
      '-g',
      'nautelle-runner@0.15.0',
    ]);
    expect(installArgv('yarn', '0.15.0')).toEqual([
      'yarn',
      'global',
      'add',
      'nautelle-runner@0.15.0',
    ]);
  });

  it('prints brew for a keg and npm when the manager is unknown', () => {
    expect(manualCommand({ kind: 'brew' }, '0.15.0')).toBe(
      'brew upgrade nautelle-runner',
    );
    expect(manualCommand({ kind: 'unknown' }, '0.15.0')).toBe(
      'npm install -g nautelle-runner@0.15.0',
    );
  });
});

describe('startUpdateCheck', () => {
  it('asks after the command and installs with the detected manager on Enter', async () => {
    const h = harness();
    await run(h);
    expect(h.asked).toEqual([
      'Update nautelle-runner 0.14.0 → 0.15.0? [Y/n/never for this version] ',
    ]);
    expect(h.installs).toEqual([
      ['npm', 'install', '-g', 'nautelle-runner@0.15.0'],
    ]);
    expect(h.stderr.join('')).toContain('Updated nautelle-runner to 0.15.0.');
  });

  it('installs on y and yes, and not on n or an ended stdin', async () => {
    for (const answer of ['y', 'Yes']) {
      const h = harness({ answer });
      await run(h);
      expect(h.installs).toHaveLength(1);
    }
    for (const answer of ['n', 'no', null]) {
      const h = harness({ answer });
      await run(h);
      expect(h.installs).toHaveLength(0);
      expect(h.stderr).toEqual([]);
    }
  });

  it.each<[string, Partial<UpdateDeps>]>([
    ['stdin is not a terminal', { stdinIsTTY: false }],
    ['stdout is not a terminal', { stdoutIsTTY: false }],
    ['CI is set', { env: { CI: 'true' } }],
    ['NAUTELLE_NO_UPDATE_CHECK=1', { env: { NAUTELLE_NO_UPDATE_CHECK: '1' } }],
    ['the command is the daemon', { command: 'run' }],
    ['the command is the MCP server', { command: 'mcp' }],
    ['the command is a hook', { command: 'hook' }],
    ['the command is a skill run', { command: 'exec-run' }],
    ['there is no command', { command: undefined }],
    ['it runs from source', { binary: null }],
    [
      'it runs from the npx cache',
      {
        binary:
          '/home/ada/.npm/_npx/1/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
      },
    ],
    ['the host has no platform package', { os: 'win32' }],
  ])('makes no request when %s', (_why, overrides) => {
    const h = harness(overrides);
    expect(startUpdateCheck(h.deps)).toBeNull();
    expect(h.requests).toEqual([]);
  });

  it('requests both packages as soon as it starts', () => {
    const h = harness();
    startUpdateCheck(h.deps);
    expect(h.requests.sort()).toEqual([
      'https://registry.npmjs.org/nautelle-runner-linux-x64/latest',
      'https://registry.npmjs.org/nautelle-runner/latest',
    ]);
  });

  it('abandons a check still running after the grace period, silently', async () => {
    const h = harness({ fetch: neverAnswers, graceMs: 10 });
    await run(h);
    expect(h.asked).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it('stays silent on a registry error', async () => {
    const h = harness({
      registry: { 'nautelle-runner': new Error('ECONNRESET') },
    });
    await run(h);
    expect(h.asked).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it('does not ask while the platform package is not published yet', async () => {
    const h = harness({
      registry: {
        'nautelle-runner': '0.15.0',
        'nautelle-runner-linux-x64': '0.14.0',
      },
    });
    await run(h);
    expect(h.asked).toEqual([]);
  });

  it('remembers never for that version only', async () => {
    const first = harness({ answer: 'never' });
    await run(first);
    expect(first.installs).toEqual([]);
    expect(readSkippedVersion(first.deps.paths.configDir)).toBe('0.15.0');
    expect(
      JSON.parse(
        readFileSync(join(first.deps.paths.configDir, UPDATE_FILE), 'utf8'),
      ),
    ).toEqual({ skipVersion: '0.15.0' });

    const same = harness();
    await run(same);
    expect(same.asked).toEqual([]);

    const next = harness({
      registry: {
        'nautelle-runner': '0.16.0',
        'nautelle-runner-linux-x64': '0.16.0',
      },
    });
    await run(next);
    expect(next.asked).toHaveLength(1);
    expect(next.asked[0]).toContain('0.14.0 → 0.16.0');
  });

  it('still answers never when the config directory cannot be written', async () => {
    const blocked = join(dir, 'file');
    writeFileSync(blocked, '');
    const h = harness({
      answer: 'never',
      paths: {
        configDir: join(blocked, 'nautelle'),
        serviceFile: join(dir, 'unit'),
        launchAgentFile: join(dir, 'plist'),
      },
    });
    await run(h);
    expect(h.installs).toEqual([]);
    expect(h.stderr.join('')).toContain('Not asking again about 0.15.0.');
  });

  it('prints the command instead of running one when the manager is unknown', async () => {
    const h = harness({ binary: '/usr/local/bin/nautelle-runner' });
    await run(h);
    expect(h.installs).toEqual([]);
    expect(h.stderr.join('')).toBe(
      'Update it with: npm install -g nautelle-runner@0.15.0\n',
    );
  });

  it('prints brew upgrade for a Homebrew install', async () => {
    const h = harness({
      binary: '/opt/homebrew/Cellar/nautelle-runner/0.14.0/bin/nautelle-runner',
    });
    await run(h);
    expect(h.installs).toEqual([]);
    expect(h.stderr.join('')).toBe(
      'Update it with: brew upgrade nautelle-runner\n',
    );
  });

  it('reports a failed install with the npm permissions hint', async () => {
    const h = harness({ installCode: 243 });
    await run(h);
    const text = h.stderr.join('');
    expect(text).toContain(
      'The update failed: npm install -g nautelle-runner@0.15.0 exited with 243.',
    );
    expect(text).toContain('resolving-eacces-permissions-errors');
    expect(text).not.toContain('Updated');
  });

  it('reports a manager that cannot start, and never throws', async () => {
    const h = harness({
      binary:
        '/home/ada/.bun/install/global/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
      installCode: new Error('ENOENT: bun'),
    });
    await run(h);
    expect(h.stderr.join('')).toBe(
      'Could not run bun add -g nautelle-runner@0.15.0: ENOENT: bun\n',
    );
  });

  it('resolves even when the terminal cannot be asked', async () => {
    const h = harness({
      ask: () => {
        throw new Error('EIO');
      },
    });
    await run(h);
    expect(h.installs).toEqual([]);
  });

  it('says how to restart an active systemd service after the update', async () => {
    const h = harness({ serviceActive: true });
    h.deps.exists = (path) =>
      path === NPM_BINARY || path === h.deps.paths.serviceFile;
    await run(h);
    expect(h.probes).toEqual([
      ['systemctl', '--user', 'is-active', '--quiet', 'nautelle-runner'],
    ]);
    expect(h.stderr.join('')).toContain(
      'The nautelle-runner service still runs 0.14.0. Restart it to run 0.15.0:\n  systemctl --user restart nautelle-runner\n',
    );
  });

  it('asks to rewrite the unit when the update removed the binary it runs', async () => {
    const h = harness({ serviceActive: true });
    h.deps.exists = (path) => path === h.deps.paths.serviceFile;
    await run(h);
    expect(h.stderr.join('')).toContain(
      'nautelle-runner install-service && systemctl --user daemon-reload && systemctl --user restart nautelle-runner',
    );
  });

  it('says how to restart an active launchd agent on macOS', async () => {
    const binary =
      '/usr/local/lib/node_modules/nautelle-runner/node_modules/nautelle-runner-darwin-arm64/bin/nautelle-runner';
    const h = harness({
      os: 'darwin',
      arch: 'arm64',
      binary,
      serviceActive: true,
      registry: {
        'nautelle-runner': '0.15.0',
        'nautelle-runner-darwin-arm64': '0.15.0',
      },
    });
    h.deps.exists = (path) =>
      path === binary || path === h.deps.paths.launchAgentFile;
    await run(h);
    expect(h.probes).toEqual([
      ['launchctl', 'print', 'gui/501/com.nautelle.runner'],
    ]);
    expect(h.stderr.join('')).toContain(
      'launchctl kickstart -k gui/501/com.nautelle.runner',
    );
  });

  it('says nothing about a service that is not installed or not running', async () => {
    const missing = harness({ serviceActive: true });
    await run(missing);
    expect(missing.probes).toEqual([]);
    expect(missing.stderr.join('')).not.toContain('Restart');

    const stopped = harness({ serviceActive: false });
    stopped.deps.exists = (path) =>
      path === NPM_BINARY || path === stopped.deps.paths.serviceFile;
    await run(stopped);
    expect(stopped.probes).toHaveLength(1);
    expect(stopped.stderr.join('')).not.toContain('Restart');
  });
});
