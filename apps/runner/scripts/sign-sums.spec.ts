import { afterAll, describe, expect, it } from 'bun:test';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_KEY_PATH, signRelease, verifySums } from './sign-sums';

const pem = (key: ReturnType<typeof generateKeyPairSync>['publicKey']) =>
  key.export({ type: 'spki', format: 'pem' }).toString();

describe('sign-sums', () => {
  const release = mkdtempSync(join(tmpdir(), 'nautelle-sign-'));
  afterAll(() => rmSync(release, { recursive: true, force: true }));
  const sums = Buffer.from(`${'1'.repeat(64)}  nautelle-runner.tar.gz\n`);
  writeFileSync(join(release, 'SHA256SUMS'), sums);

  it('writes an Ed25519 signature of SHA256SUMS that verifies against the release key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    signRelease(release, privateKey, pem(publicKey));
    const signature = readFileSync(join(release, 'SHA256SUMS.sig'));
    expect(signature.length).toBe(64);
    expect(verifySums(sums, signature, publicKey)).toBe(true);
    expect(verifySums(Buffer.from('changed'), signature, publicKey)).toBe(
      false,
    );
  });

  it('refuses a key that is not the private half of the release key, and writes nothing', () => {
    rmSync(join(release, 'SHA256SUMS.sig'), { force: true });
    const release_ = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    expect(() =>
      signRelease(release, other.privateKey, pem(release_.publicKey)),
    ).toThrow('not the private half of apps/runner/release-key.pub');
    expect(existsSync(join(release, 'SHA256SUMS.sig'))).toBe(false);
  });

  it('keeps an Ed25519 public key in apps/runner/release-key.pub', () => {
    const key = createPublicKey(readFileSync(RELEASE_KEY_PATH, 'utf8'));
    expect(key.asymmetricKeyType).toBe('ed25519');
  });
});
