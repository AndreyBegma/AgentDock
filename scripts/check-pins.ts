/**
 * Checks that every dependency of every workspace `package.json` is pinned to
 * an exact version (`bunfig.toml` sets `exact = true`): no `^`, `~`, `*`, `x`,
 * comparison or tag ranges. A version range lets a lockfile refresh pull a new
 * upstream release nobody reviewed. `workspace:` references are allowed.
 *
 *   bun scripts/check-pins.ts [package.json ...]
 *
 * Without arguments it checks the root `package.json` and every workspace the
 * root lists. Renovate opens the update pull requests (renovate.json). Exits 1
 * and lists the violations when there are any.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
] as const;

/** `1.2.3`, `1.2.3-rc.1`, `1.2.3+build` — one version, nothing else. */
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const isPinned = (spec: string): boolean =>
  EXACT.test(spec) || spec.startsWith('workspace:');

export const checkManifest = (source: string): string[] => {
  const manifest = JSON.parse(source) as Record<string, unknown>;
  return SECTIONS.flatMap((section) => {
    const deps = manifest[section];
    if (typeof deps !== 'object' || deps === null) return [];
    return Object.entries(deps as Record<string, unknown>).flatMap(
      ([name, spec]) =>
        typeof spec === 'string' && !isPinned(spec)
          ? [`${section}: \`${name}\` is \`${spec}\`, not an exact version`]
          : [],
    );
  });
};

/** The root manifest and every workspace `dir/*` or `dir` it lists. */
const manifests = (): string[] => {
  const rootManifest = join(root, 'package.json');
  const { workspaces = [] } = JSON.parse(
    readFileSync(rootManifest, 'utf8'),
  ) as { workspaces?: string[] };
  const dirs = workspaces.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [join(root, pattern)];
    const parent = join(root, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  });
  return [
    rootManifest,
    ...dirs
      .map((dir) => join(dir, 'package.json'))
      .filter((path) => existsSync(path)),
  ];
};

if (import.meta.main) {
  const files =
    process.argv.length > 2
      ? process.argv.slice(2).map((path) => resolve(path))
      : manifests();
  const violations = files.flatMap((file) =>
    checkManifest(readFileSync(file, 'utf8')).map(
      (problem) => `${relative(root, file)}: ${problem}`,
    ),
  );
  if (violations.length > 0) {
    console.error(`check-pins: ${violations.length} violation(s)`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(`check-pins: ${files.length} manifest(s) ok`);
}
