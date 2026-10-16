// Signs a runner release's SHA256SUMS (ADR-0047): writes
// `<release>/SHA256SUMS.sig`, the raw 64-byte Ed25519 signature of the file.
// The npm shim and the Homebrew formula refuse a binary whose checksum is not
// in a SHA256SUMS signed by apps/runner/release-key.pub.
//
//   RUNNER_SIGNING_KEY=<PEM private key> bun scripts/sign-sums.ts <release dir>
//   bun scripts/sign-sums.ts --throwaway <release dir>
//
// With RUNNER_SIGNING_KEY, the key must be the private half of
// release-key.pub, or nothing is written. --throwaway signs with a key made
// for this run only, so a build without the release key still produces every
// asset; nothing it signs verifies against release-key.pub, so the shim and
// the formula refuse it.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_KEY_PATH = join(import.meta.dir, '..', 'release-key.pub');

/** The Ed25519 signature of `data`. */
export const signSums = (data: Buffer, privateKey: KeyObject): Buffer =>
  sign(null, data, privateKey);

/** Whether `signature` is `publicKey`'s signature of `data`. */
export const verifySums = (
  data: Buffer,
  signature: Buffer,
  publicKey: KeyObject | string,
): boolean => {
  try {
    return verify(null, data, publicKey, signature);
  } catch {
    return false;
  }
};

/** Signs `<release>/SHA256SUMS`; throws when the key is not the release key. */
export const signRelease = (
  release: string,
  privateKey: KeyObject,
  releaseKey: string,
): void => {
  const sums = readFileSync(join(release, 'SHA256SUMS'));
  const signature = signSums(sums, privateKey);
  const expected = createPublicKey(releaseKey);
  if (!verifySums(sums, signature, expected)) {
    throw new Error(
      'RUNNER_SIGNING_KEY is not the private half of apps/runner/release-key.pub',
    );
  }
  writeFileSync(join(release, 'SHA256SUMS.sig'), signature);
};

if (import.meta.main) {
  const throwaway = process.argv[2] === '--throwaway';
  const release = process.argv[throwaway ? 3 : 2];
  if (!release) {
    console.error(
      'usage: RUNNER_SIGNING_KEY=<PEM> bun scripts/sign-sums.ts <release dir>\n' +
        '       bun scripts/sign-sums.ts --throwaway <release dir>',
    );
    process.exit(2);
  }
  if (throwaway) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    signRelease(
      release,
      privateKey,
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    console.log('sign-sums: SHA256SUMS signed with a throwaway key');
  } else {
    const pem = process.env.RUNNER_SIGNING_KEY;
    if (!pem) {
      console.error('sign-sums: RUNNER_SIGNING_KEY is not set');
      process.exit(1);
    }
    try {
      signRelease(
        release,
        // A secret pasted as one line keeps its newlines as literal \n.
        createPrivateKey(pem.replaceAll('\\n', '\n')),
        readFileSync(RELEASE_KEY_PATH, 'utf8'),
      );
    } catch (error) {
      console.error(`sign-sums: ${(error as Error).message}`);
      process.exit(1);
    }
    console.log('sign-sums: SHA256SUMS signed with the release key');
  }
}
