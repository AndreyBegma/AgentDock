#!/usr/bin/env node
// The npm entry point of agentdock-runner (ADR-0017). The runner is a Bun
// binary, so this shim only finds the platform package npm installed from
// optionalDependencies and runs its binary with the same arguments and stdio.

const { execFileSync } = require('node:child_process');
const { constants } = require('node:os');

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

/** The platform package for `platform`/`arch`, or null when none is built. */
const platformPackage = (platform, arch) => {
  const target = `${platform}-${arch}`;
  return TARGETS.includes(target) ? `agentdock-runner-${target}` : null;
};

/** What to print when no binary can be run here. */
const noMatchMessage = (platform, arch) => {
  const pkg = platformPackage(platform, arch);
  const why = pkg
    ? `the package ${pkg} is not installed (were optional dependencies skipped, e.g. --no-optional or --omit=optional?)`
    : `there is no prebuilt binary for ${platform}-${arch}`;
  return [
    `agentdock-runner: ${why}.`,
    '',
    `Supported targets: ${TARGETS.join(', ')}.`,
    'Other ways to install it:',
    '  brew install andreybegma/tap/agentdock-runner',
    '  build from source: https://github.com/AndreyBegma/AgentDock/tree/main/apps/runner',
    '',
  ].join('\n');
};

/** The binary's path, or null; `resolve` is `require.resolve`. */
const resolveBinary = (platform, arch, resolve) => {
  const pkg = platformPackage(platform, arch);
  if (!pkg) return null;
  try {
    return resolve(`${pkg}/bin/agentdock-runner`);
  } catch {
    return null;
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
    execFileSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  } catch (error) {
    if (error.status == null && !error.signal) {
      process.stderr.write(
        `agentdock-runner: could not run ${binary}: ${error.message}\n`,
      );
    }
    process.exit(exitCodeOf(error));
  }
};

module.exports = {
  TARGETS,
  platformPackage,
  noMatchMessage,
  resolveBinary,
  exitCodeOf,
};

if (require.main === module) main();
