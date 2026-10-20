import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_CLOSE_AS_SUCCESS } from '../src/service';

const script = join(import.meta.dir, 'render-formula.sh');
const fixture = join(
  import.meta.dir,
  '..',
  'homebrew',
  'fixtures',
  'SHA256SUMS',
);

const signature = `${fixture}.sig`;
const sha256 = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

const render = (version: string, sums: string) =>
  Bun.spawnSync(['sh', script, version, sums, signature], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('render-formula.sh', () => {
  const run = render('9.8.7', fixture);
  const formula = run.stdout.toString();

  it('renders every target with its release URL and checksum', () => {
    expect(run.exitCode).toBe(0);
    const expected = {
      'darwin-arm64': '1'.repeat(64),
      'darwin-x64': '2'.repeat(64),
      'linux-x64': '3'.repeat(64),
      'linux-arm64': '4'.repeat(64),
    };
    for (const [target, sha] of Object.entries(expected)) {
      const url = `https://github.com/AndreyBegma/AgentDock/releases/download/runner-v9.8.7/nautelle-runner-9.8.7-${target}.tar.gz`;
      expect(formula).toContain(`url "${url}"\n      sha256 "${sha}"`);
    }
    expect(formula).toContain('version "9.8.7"');
    expect(formula).not.toMatch(/@[A-Z0-9_]+@/);
  });

  it('pins SHA256SUMS and its signature as resources of the release', () => {
    const base =
      'https://github.com/AndreyBegma/AgentDock/releases/download/runner-v9.8.7';
    expect(formula).toContain(
      `url "${base}/SHA256SUMS"\n    sha256 "${sha256(readFileSync(fixture))}"`,
    );
    expect(formula).toContain(
      `url "${base}/SHA256SUMS.sig"\n    sha256 "${sha256(readFileSync(signature))}"`,
    );
  });

  it('embeds apps/runner/release-key.pub and checks the signature before installing', () => {
    const key = readFileSync(
      join(import.meta.dir, '..', 'release-key.pub'),
      'utf8',
    );
    const embedded = /RELEASE_KEY = <<~PEM\.freeze\n([\s\S]*?)\n {2}PEM/.exec(
      formula,
    )?.[1];
    expect(embedded?.replace(/^ {4}/gm, '')).toBe(key.trim());
    const install = formula.slice(formula.indexOf('  def install'));
    expect(install.indexOf('verify_release!')).toBeLessThan(
      install.indexOf('bin.install'),
    );
  });

  it('installs nautelle-runner and links the old agentdock-runner command to it (ADR-0073)', () => {
    expect(formula).toContain('class NautelleRunner < Formula');
    expect(formula).toContain('bin.install "nautelle-runner"');
    expect(formula).toContain(
      'bin.install_symlink bin/"nautelle-runner" => "agentdock-runner"',
    );
  });

  it('runs the service through the same exit-78 wrapper as the launchd agent', () => {
    expect(formula).toContain(`'${TERMINAL_CLOSE_AS_SUCCESS}'`);
    expect(formula).toContain('keep_alive successful_exit: false');
  });

  // The formula's own check, run by Ruby against a stub of Homebrew's Formula.
  // CI has no Ruby; run it where there is one.
  describe.skipIf(!Bun.which('ruby'))('verify_release! under Ruby', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nautelle-formula-rb-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const name = 'nautelle-runner-9.8.7-linux-x64.tar.gz';
    const tarball = 'the real tarball';
    const sums = Buffer.from(`${sha256(tarball)}  ${name}\n`);
    writeFileSync(join(dir, 'formula.rb'), formula);
    writeFileSync(join(dir, 'SHA256SUMS'), sums);
    writeFileSync(join(dir, 'good.sig'), sign(null, sums, privateKey));
    writeFileSync(
      join(dir, 'other.sig'),
      sign(null, sums, generateKeyPairSync('ed25519').privateKey),
    );
    writeFileSync(
      join(dir, 'key.pem'),
      publicKey.export({ type: 'spki', format: 'pem' }),
    );
    writeFileSync(
      join(dir, 'check.rb'),
      [
        'class Formula',
        '  def self.method_missing(*) = nil',
        '  def self.respond_to_missing?(*) = true',
        '  def self.test(*) = nil',
        'end',
        'dir = ARGV.shift',
        'load File.join(dir, "formula.rb")',
        'sig, name, digest, key = ARGV',
        'key = key == "release" ? NautelleRunner::RELEASE_KEY : File.read(File.join(dir, "key.pem"))',
        'NautelleRunner.verify_release!(File.binread(File.join(dir, "SHA256SUMS")), File.binread(File.join(dir, sig)), name, digest, key)',
        'puts "ok"',
      ].join('\n'),
    );
    const check = (sig: string, file: string, digest: string, key = 'test') =>
      Bun.spawnSync(
        ['ruby', join(dir, 'check.rb'), dir, sig, file, digest, key],
        { stdout: 'pipe', stderr: 'pipe' },
      );

    it('accepts a tarball listed in a correctly signed SHA256SUMS', () => {
      const run = check('good.sig', name, sha256(tarball));
      expect(run.stderr.toString()).toBe('');
      expect(run.stdout.toString()).toBe('ok\n');
    });

    it('refuses a tarball whose checksum is not listed', () => {
      const run = check('good.sig', name, sha256('a malicious tarball'));
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain(
        `${name} does not match its checksum in SHA256SUMS`,
      );
    });

    it('refuses a SHA256SUMS signed by another key, or checked against the release key', () => {
      for (const run of [
        check('other.sig', name, sha256(tarball)),
        check('good.sig', name, sha256(tarball), 'release'),
      ]) {
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr.toString()).toContain(
          'SHA256SUMS is not signed by the Nautelle release key',
        );
      }
    });
  });

  describe('with a target missing from SHA256SUMS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nautelle-formula-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('fails and names the tarball', () => {
      const partial = join(dir, 'SHA256SUMS');
      writeFileSync(
        partial,
        readFileSync(fixture, 'utf8')
          .split('\n')
          .filter((line) => !line.includes('linux-x64'))
          .join('\n'),
      );
      const failed = render('9.8.7', partial);
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr.toString()).toContain(
        'nautelle-runner-9.8.7-linux-x64.tar.gz',
      );
    });
  });
});
