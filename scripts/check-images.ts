/**
 * Checks that nothing the images are built from is fetched unverified:
 *
 *   - every `FROM` and `COPY --from=<image>` in a Dockerfile names its image
 *     with `@sha256:` (a build argument is resolved to its default first);
 *   - no Dockerfile pipes a download into a shell (`curl … | bash`, `| sh`);
 *   - every third-party `image:` in a compose file carries a digest.
 *
 * Nautelle's own images are exempt: the staging ones are built locally, the
 * public install picks a published release by tag, from ghcr.io or the
 * registry in NAUTELLE_REGISTRY (ADR-0088), and the all-in-one image is
 * assembled from the digests release-images.sh has just pushed (ADR-0097).
 *
 *   bun scripts/check-images.ts [file ...]
 *
 * Without arguments it checks every Dockerfile and compose file in the
 * repository. Renovate owns the digests (renovate.json). Exits 1 and lists the
 * violations when there are any.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', 'dist']);
/**
 * Nautelle's own images: built locally for staging (`agentdock-*`), or the
 * published ones selected by release tag (ADR-0088, ADR-0097).
 */
const OWN_IMAGE =
  /^(agentdock-|(ghcr\.io\/andreybegma|\$\{NAUTELLE_REGISTRY:-ghcr\.io\/andreybegma\})\/nautelle(-api|-web)?:)/;

const isDockerfile = (name: string) => /^Dockerfile(\..+)?$/.test(name);
const isCompose = (name: string) => /^docker-compose(\..+)?\.ya?ml$/.test(name);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
    }
    return isDockerfile(entry.name) || isCompose(entry.name)
      ? [join(dir, entry.name)]
      : [];
  });

/** Dockerfile instructions, one per entry: continuations joined, comments dropped. */
const instructions = (source: string): { line: number; text: string }[] => {
  const result: { line: number; text: string }[] = [];
  let current: { line: number; text: string } | undefined;
  source.split('\n').forEach((raw, index) => {
    if (current === undefined && /^\s*(#|$)/.test(raw)) return;
    if (current !== undefined && /^\s*#/.test(raw)) return;
    const continued = /\\\s*$/.test(raw);
    const text = raw.replace(/\\\s*$/, '').trim();
    if (current === undefined) current = { line: index + 1, text };
    else current.text += ` ${text}`;
    if (!continued) {
      result.push(current);
      current = undefined;
    }
  });
  if (current !== undefined) result.push(current);
  return result;
};

const DIGEST = /@sha256:[0-9a-f]{64}$/;

export const checkDockerfile = (source: string): string[] => {
  const problems: string[] = [];
  const args = new Map<string, string>();
  const stages = new Set<string>();

  const resolveImage = (image: string): string =>
    image.replace(
      /\$\{(\w+)\}|\$(\w+)/g,
      (match, braced: string | undefined, bare: string | undefined) =>
        args.get(braced ?? (bare as string)) ?? match,
    );

  const checkImage = (line: number, image: string) => {
    const resolved = resolveImage(image);
    if (stages.has(resolved) || resolved === 'scratch') return;
    if (OWN_IMAGE.test(resolved)) return;
    if (!DIGEST.test(resolved)) {
      problems.push(`${line}: image \`${image}\` is not pinned by @sha256:`);
    }
  };

  for (const { line, text } of instructions(source)) {
    const [keyword = '', ...rest] = text.split(/\s+/);
    const word = keyword.toUpperCase();
    if (word === 'ARG') {
      const match = /^(\w+)=(.*)$/.exec(rest.join(' '));
      if (match) args.set(match[1] as string, match[2] as string);
    } else if (word === 'FROM') {
      const image = rest.find((part) => !part.startsWith('--'));
      if (image !== undefined) checkImage(line, image);
      const as = rest.findIndex((part) => part.toUpperCase() === 'AS');
      if (as !== -1 && rest[as + 1] !== undefined) {
        stages.add(rest[as + 1] as string);
      }
    } else if (word === 'COPY' || word === 'ADD') {
      const from = rest.find((part) => part.startsWith('--from='));
      if (from !== undefined) checkImage(line, from.slice('--from='.length));
    }
    if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(text)) {
      problems.push(`${line}: a download is piped into a shell`);
    }
  }
  return problems;
};

export const checkCompose = (source: string): string[] =>
  source.split('\n').flatMap((raw, index) => {
    const match = /^\s*image:\s*(\S+)/.exec(raw);
    const image = match?.[1];
    if (image === undefined || OWN_IMAGE.test(image) || DIGEST.test(image)) {
      return [];
    }
    return [`${index + 1}: image \`${image}\` is not pinned by @sha256:`];
  });

export const checkFile = (path: string): string[] => {
  const source = readFileSync(path, 'utf8');
  return isDockerfile(basename(path))
    ? checkDockerfile(source)
    : checkCompose(source);
};

if (import.meta.main) {
  const files =
    process.argv.length > 2
      ? process.argv.slice(2).map((path) => resolve(path))
      : walk(root);
  const violations = files.flatMap((file) =>
    checkFile(file).map((problem) => `${relative(root, file)}:${problem}`),
  );
  if (violations.length > 0) {
    console.error(`check-images: ${violations.length} violation(s)`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(`check-images: ${files.length} file(s) ok`);
}
