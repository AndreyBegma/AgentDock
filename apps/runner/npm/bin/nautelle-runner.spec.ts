import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import shim from './nautelle-runner.js';

const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

/** A key pair standing in for the release key, and a signer for it. */
const testKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (data: Buffer) => sign(null, data, privateKey),
  };
};

const found = (path: string) => `/node_modules/${path}`;
const missing = (path: string): string => {
  throw new Error(`Cannot find module '${path}'`);
};

describe('the npm shim', () => {
  it('maps each supported platform to its package', () => {
    expect(shim.platformPackage('darwin', 'arm64')).toBe(
      'nautelle-runner-darwin-arm64',
    );
    expect(shim.platformPackage('darwin', 'x64')).toBe(
      'nautelle-runner-darwin-x64',
    );
    expect(shim.platformPackage('linux', 'x64')).toBe(
      'nautelle-runner-linux-x64',
    );
    expect(shim.platformPackage('linux', 'arm64')).toBe(
      'nautelle-runner-linux-arm64',
    );
  });

  it('has no package for an unsupported platform', () => {
    expect(shim.platformPackage('win32', 'x64')).toBeNull();
    expect(shim.platformPackage('linux', 'ia32')).toBeNull();
    expect(shim.resolveBinary('win32', 'x64', found)).toBeNull();
  });

  it('resolves the binary inside the platform package', () => {
    expect(shim.resolveBinary('linux', 'x64', found)).toBe(
      '/node_modules/nautelle-runner-linux-x64/bin/nautelle-runner',
    );
  });

  it('returns null when the platform package was not installed', () => {
    expect(shim.resolveBinary('darwin', 'arm64', missing)).toBeNull();
  });

  it('on no match, lists the supported targets and the alternatives', () => {
    const message = shim.noMatchMessage('win32', 'x64');
    expect(message).toContain('no prebuilt binary for win32-x64');
    for (const target of shim.TARGETS) expect(message).toContain(target);
    expect(message).toContain('brew install andreybegma/tap/nautelle-runner');
    expect(message).toContain('build from source');
  });

  it('on a supported platform without its package, says optional dependencies were skipped', () => {
    expect(shim.noMatchMessage('linux', 'arm64')).toContain(
      'nautelle-runner-linux-arm64 is not installed',
    );
  });

  it('passes the exit code through, and a signal as 128 + its number', () => {
    expect(shim.exitCodeOf({ status: 78 })).toBe(78);
    expect(shim.exitCodeOf({ status: null, signal: 'SIGTERM' })).toBe(143);
    expect(shim.exitCodeOf({ status: null, signal: null })).toBe(1);
  });

  it('embeds apps/runner/release-key.pub', () => {
    expect(shim.RELEASE_KEY).toBe(
      readFileSync(
        join(import.meta.dir, '..', '..', 'release-key.pub'),
        'utf8',
      ),
    );
  });

  describe('verifying a checksum', () => {
    const key = testKey();
    const name = 'bin/linux-x64/nautelle-runner';
    const digest = 'a'.repeat(64);
    const sums = Buffer.from(
      `${'b'.repeat(64)}  nautelle-runner-1.0.0-linux-x64.tar.gz\n${digest} *${name}\n`,
    );
    const check =
      (overrides: Record<string, unknown> = {}) =>
      () =>
        shim.verifyChecksum({
          sums,
          signature: key.sign(sums),
          name,
          digest,
          publicKey: key.publicKey,
          ...overrides,
        });

    it('accepts a listed checksum in a correctly signed SHA256SUMS', () => {
      expect(check()).not.toThrow();
    });

    it('refuses a checksum that SHA256SUMS does not list', () => {
      expect(check({ digest: 'c'.repeat(64) })).toThrow(
        `${name} does not match its checksum in SHA256SUMS`,
      );
      expect(check({ name: 'bin/darwin-x64/nautelle-runner' })).toThrow(
        'SHA256SUMS lists no checksum for bin/darwin-x64/nautelle-runner',
      );
    });

    it('refuses a SHA256SUMS that was changed after signing', () => {
      const forged = Buffer.from(
        sums.toString().replace(digest, 'c'.repeat(64)),
      );
      expect(
        check({
          sums: forged,
          signature: key.sign(sums),
          digest: 'c'.repeat(64),
        }),
      ).toThrow('SHA256SUMS is not signed by the Nautelle release key');
    });

    it('refuses a SHA256SUMS signed by another key', () => {
      const other = testKey();
      expect(check({ signature: other.sign(sums) })).toThrow(
        'not signed by the Nautelle release key',
      );
      expect(check({ signature: Buffer.alloc(0) })).toThrow(
        'not signed by the Nautelle release key',
      );
    });

    it('trusts only the release key by default', () => {
      expect(check({ publicKey: undefined })).toThrow(
        'not signed by the Nautelle release key',
      );
    });
  });

  describe('verifying a binary', () => {
    const key = testKey();
    const root = mkdtempSync(join(tmpdir(), 'nautelle-verify-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const binary = join(root, 'nautelle-runner');
    const release = (content: string) => {
      writeFileSync(binary, content);
      rmSync(`${binary}.verified`, { force: true });
      const sums = Buffer.from(
        `${sha256(content)}  bin/linux-x64/nautelle-runner\n`,
      );
      writeFileSync(join(root, 'SHA256SUMS'), sums);
      writeFileSync(join(root, 'SHA256SUMS.sig'), key.sign(sums));
    };
    const verifyIt = () =>
      shim.verifyBinary(binary, 'linux-x64', root, key.publicKey);

    it('accepts the released binary and remembers its digest', () => {
      release('the real binary');
      expect(verifyIt).not.toThrow();
      expect(readFileSync(`${binary}.verified`, 'utf8')).toEndWith(
        sha256('the real binary'),
      );
      expect(verifyIt).not.toThrow();
    });

    it('refuses a binary replaced after it was verified', () => {
      release('the real binary');
      verifyIt();
      writeFileSync(binary, 'a malicious binary');
      utimesSync(binary, new Date(), new Date(Date.now() + 5_000));
      expect(verifyIt).toThrow(
        'bin/linux-x64/nautelle-runner does not match its checksum',
      );
    });

    it('refuses to run without a signature', () => {
      release('the real binary');
      rmSync(join(root, 'SHA256SUMS.sig'));
      expect(verifyIt).toThrow('SHA256SUMS.sig is missing');
    });
  });

  describe('installed, under node', () => {
    const root = mkdtempSync(join(tmpdir(), 'nautelle-shim-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const modules = join(root, 'node_modules');
    const shimPath = join(
      modules,
      'nautelle-runner',
      'bin',
      'nautelle-runner.js',
    );
    mkdirSync(dirname(shimPath), { recursive: true });
    // The installed shim trusts a test key in place of the release key.
    const key = testKey();
    writeFileSync(
      shimPath,
      readFileSync(join(import.meta.dir, 'nautelle-runner.js'), 'utf8').replace(
        shim.RELEASE_KEY,
        key.publicKey,
      ),
    );
    const target = `${process.platform}-${process.arch}`;
    const binary = join(
      modules,
      `nautelle-runner-${target}`,
      'bin',
      'nautelle-runner',
    );

    const script = '#!/bin/sh\nprintf "%s|" "$@"\nexit 78\n';
    const writeRelease = (listed: string) => {
      const sums = Buffer.from(
        `${sha256(listed)}  bin/${target}/nautelle-runner\n`,
      );
      const wrapper = join(modules, 'nautelle-runner');
      writeFileSync(join(wrapper, 'SHA256SUMS'), sums);
      writeFileSync(join(wrapper, 'SHA256SUMS.sig'), key.sign(sums));
    };

    const runShim = () =>
      Bun.spawnSync(['node', shimPath, 'a', 'b c'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

    it('without the platform package, prints the no-match message and exits 1', () => {
      const run = runShim();
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain('Supported targets:');
    });

    it('runs the platform binary with the arguments and passes its exit code through', () => {
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, script, { mode: 0o755 });
      writeRelease(script);
      const run = runShim();
      expect(run.stdout.toString()).toBe('a|b c|');
      expect(run.exitCode).toBe(78);
    });

    it('refuses a binary whose checksum is not in the signed SHA256SUMS, and never runs it', () => {
      writeFileSync(binary, script, { mode: 0o755 });
      rmSync(`${binary}.verified`, { force: true });
      writeRelease('some other binary');
      const run = runShim();
      expect(run.exitCode).toBe(1);
      expect(run.stdout.toString()).toBe('');
      expect(run.stderr.toString()).toContain(
        `refusing to run ${binary}: bin/${target}/nautelle-runner does not match its checksum in SHA256SUMS`,
      );
      expect(existsSync(`${binary}.verified`)).toBe(false);
    });
  });
});
