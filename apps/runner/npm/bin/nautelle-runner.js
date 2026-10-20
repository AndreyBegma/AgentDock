#!/usr/bin/env node
// The npm entry point of nautelle-runner (ADR-0017). The runner is a Bun
// binary, so this shim only finds the platform package npm installed from
// optionalDependencies and runs its binary with the same arguments and stdio.
// It runs a binary only when its checksum is in the SHA256SUMS this package
// ships and that file is signed by the Nautelle release key (ADR-0049).

const { execFileSync } = require('node:child_process');
const { createHash, verify } = require('node:crypto');
const fs = require('node:fs');
const { constants } = require('node:os');
const path = require('node:path');

/** apps/runner/release-key.pub of Nautelle. */
const RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUZTyf8lH2FdBavFF1oadsbBAOQD9kXfGp4YHCNFB3r8=
-----END PUBLIC KEY-----
`;

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

/** The platform package for `platform`/`arch`, or null when none is built. */
const platformPackage = (platform, arch) => {
  const target = `${platform}-${arch}`;
  return TARGETS.includes(target) ? `nautelle-runner-${target}` : null;
};

/** What to print when no binary can be run here. */
const noMatchMessage = (platform, arch) => {
  const pkg = platformPackage(platform, arch);
  const why = pkg
    ? `the package ${pkg} is not installed (were optional dependencies skipped, e.g. --no-optional or --omit=optional?)`
    : `there is no prebuilt binary for ${platform}-${arch}`;
  return [
    `nautelle-runner: ${why}.`,
    '',
    `Supported targets: ${TARGETS.join(', ')}.`,
    'Other ways to install it:',
    '  brew install andreybegma/tap/nautelle-runner',
    '  build from source: https://github.com/AndreyBegma/Nautelle/tree/main/apps/runner',
    '',
  ].join('\n');
};

/** The binary's path, or null; `resolve` is `require.resolve`. */
const resolveBinary = (platform, arch, resolve) => {
  const pkg = platformPackage(platform, arch);
  if (!pkg) return null;
  try {
    return resolve(`${pkg}/bin/nautelle-runner`);
  } catch {
    return null;
  }
};

/** The checksums `sums` lists for `name`; sha256sum may mark binary mode with '*'. */
const checksumsOf = (sums, name) =>
  sums.split('\n').flatMap((line) => {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ''));
    return match && match[2] === name ? [match[1]] : [];
  });

/**
 * Throws unless `sums` (a Buffer) is signed by `publicKey` and lists `digest`
 * for `name`.
 */
const verifyChecksum = ({
  sums,
  signature,
  name,
  digest,
  publicKey = RELEASE_KEY,
}) => {
  let signed = false;
  try {
    signed = verify(null, sums, publicKey, signature);
  } catch {}
  if (!signed) {
    throw new Error('SHA256SUMS is not signed by the Nautelle release key');
  }
  const listed = checksumsOf(sums.toString('utf8'), name);
  if (listed.length === 0) {
    throw new Error(`SHA256SUMS lists no checksum for ${name}`);
  }
  if (!listed.includes(digest)) {
    throw new Error(`${name} does not match its checksum in SHA256SUMS`);
  }
};

/** The sha256 of a file, read in chunks. */
const sha256File = (file) => {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
};

/**
 * Throws unless `binary` is the release binary of `target`. `dir` holds
 * SHA256SUMS and SHA256SUMS.sig. A binary is hashed once: its size, mtime and
 * digest go to `<binary>.verified`, and later runs re-check only the
 * signature and the listing. Whoever can rewrite that file can rewrite the
 * binary too.
 */
const verifyBinary = (binary, target, dir, publicKey = RELEASE_KEY) => {
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(dir, file));
    } catch {
      throw new Error(`${file} is missing from ${dir}`);
    }
  };
  const sums = read('SHA256SUMS');
  const signature = read('SHA256SUMS.sig');
  const stat = fs.statSync(binary);
  const stampFile = `${binary}.verified`;
  const stamp = `${stat.size}:${stat.mtimeMs}:`;
  let digest = null;
  try {
    const cached = fs.readFileSync(stampFile, 'utf8');
    if (cached.startsWith(stamp)) digest = cached.slice(stamp.length);
  } catch {}
  const hashed = digest === null;
  if (hashed) digest = sha256File(binary);
  verifyChecksum({
    sums,
    signature,
    name: `bin/${target}/nautelle-runner`,
    digest,
    publicKey,
  });
  if (hashed) {
    try {
      fs.writeFileSync(stampFile, `${stamp}${digest}`);
    } catch {}
  }
};

/** The exit code that mirrors how the binary ended. */
const exitCodeOf = (error) => {
  if (typeof error.status === 'number') return error.status;
  if (error.signal) return 128 + (constants.signals[error.signal] ?? 0);
  return 1;
};

const main = () => {
  const binary = resolveBinary(process.platform, process.arch, require.resolve);
  if (!binary) {
    process.stderr.write(noMatchMessage(process.platform, process.arch));
    process.exit(1);
  }
  try {
    verifyBinary(
      binary,
      `${process.platform}-${process.arch}`,
      path.join(__dirname, '..'),
    );
  } catch (error) {
    process.stderr.write(
      `nautelle-runner: refusing to run ${binary}: ${error.message}. Reinstall nautelle-runner; if it happens again, do not run the binary and report it at https://github.com/AndreyBegma/Nautelle/security.\n`,
    );
    process.exit(1);
  }
  try {
    execFileSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  } catch (error) {
    if (error.status == null && !error.signal) {
      process.stderr.write(
        `nautelle-runner: could not run ${binary}: ${error.message}\n`,
      );
    }
    process.exit(exitCodeOf(error));
  }
};

module.exports = {
  RELEASE_KEY,
  TARGETS,
  checksumsOf,
  verifyChecksum,
  verifyBinary,
  platformPackage,
  noMatchMessage,
  resolveBinary,
  exitCodeOf,
  main,
};

if (require.main === module) main();
