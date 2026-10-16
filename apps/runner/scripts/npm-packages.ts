// Writes the npm packages of a runner release (ADR-0017) under
// `<release>/npm/`: one `agentdock-runner-<os>-<arch>` per target, holding
// only its binary, and the `agentdock-runner` wrapper whose
// optionalDependencies pin them at the same exact version. The wrapper also
// carries SHA256SUMS and SHA256SUMS.sig, which its shim checks a binary
// against before running it (ADR-0047).
//
//   bun scripts/npm-packages.ts <release dir>
//
// The binaries are read from `<release>/bin/<os>-<arch>/agentdock-runner`,
// and `<release>/SHA256SUMS{,.sig}`, which build-release.sh writes first.
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
] as const;

const runner = join(import.meta.dir, '..');
const npmDir = join(runner, 'npm');

/** The platform package.json for `target`, from the template. */
export const platformManifest = (
  template: string,
  version: string,
  target: string,
): string => {
  const [os, arch] = target.split('-');
  if (!os || !arch) throw new Error(`not an <os>-<arch> target: ${target}`);
  return template
    .replaceAll('{{version}}', version)
    .replaceAll('{{os}}', os)
    .replaceAll('{{arch}}', arch);
};

/** The wrapper package.json, stamped with the release version. */
export const wrapperManifest = (wrapper: string, version: string): string => {
  const manifest = JSON.parse(wrapper) as Record<string, unknown>;
  manifest.version = version;
  manifest.optionalDependencies = Object.fromEntries(
    TARGETS.map((target) => [`agentdock-runner-${target}`, version]),
  );
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

/** Writes every package; returns their directories, platform packages first. */
export const writeNpmPackages = (
  release: string,
  version: string,
): string[] => {
  const template = readFileSync(
    join(npmDir, 'platform-package.template.json'),
    'utf8',
  );
  const written: string[] = [];
  for (const target of TARGETS) {
    const dir = join(release, 'npm', `agentdock-runner-${target}`);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      platformManifest(template, version, target),
    );
    writeFileSync(
      join(dir, 'README.md'),
      `# agentdock-runner-${target}\n\nThe \`agentdock-runner\` binary for ${target}. Install [\`agentdock-runner\`](https://www.npmjs.com/package/agentdock-runner) instead; it picks this package for you.\n`,
    );
    const binary = join(dir, 'bin', 'agentdock-runner');
    copyFileSync(join(release, 'bin', target, 'agentdock-runner'), binary);
    chmodSync(binary, 0o755);
    written.push(dir);
  }

  const wrapper = join(release, 'npm', 'agentdock-runner');
  mkdirSync(join(wrapper, 'bin'), { recursive: true });
  writeFileSync(
    join(wrapper, 'package.json'),
    wrapperManifest(
      readFileSync(join(npmDir, 'package.json'), 'utf8'),
      version,
    ),
  );
  copyFileSync(join(npmDir, 'README.md'), join(wrapper, 'README.md'));
  for (const file of ['SHA256SUMS', 'SHA256SUMS.sig']) {
    copyFileSync(join(release, file), join(wrapper, file));
  }
  const shim = join(wrapper, 'bin', 'agentdock-runner.js');
  copyFileSync(join(npmDir, 'bin', 'agentdock-runner.js'), shim);
  chmodSync(shim, 0o755);
  written.push(wrapper);
  return written;
};

if (import.meta.main) {
  const release = process.argv[2];
  if (!release) {
    console.error('usage: bun scripts/npm-packages.ts <release dir>');
    process.exit(2);
  }
  const { version } = JSON.parse(
    readFileSync(join(runner, 'package.json'), 'utf8'),
  ) as { version: string };
  for (const dir of writeNpmPackages(release, version)) {
    console.log(`npm-packages: ${dir}`);
  }
}
