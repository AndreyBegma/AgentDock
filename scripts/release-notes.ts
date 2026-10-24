/**
 * Composes the body of a product GitHub Release (ADR-0091):
 *
 *   - the summary and the "What changed" section of the release note the
 *     release skill commits, `docs/releases/vX.Y.Z.md` (ADR-0071);
 *   - the install and upgrade commands;
 *   - the digest of each published image, from `.release/images.json`, which
 *     deploy/images/release-images.sh writes, and how to verify its signature;
 *   - the runner version in the tree (`apps/runner/package.json`).
 *
 *   bun scripts/release-notes.ts vX.Y.Z [out.md]
 *
 * Writes to `out.md`, or to stdout without it. Exits 1 when the note or the
 * image digests are missing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const REPO = 'AndreyBegma/Nautelle';

export interface ImageDigest {
  /** `ghcr.io/andreybegma/nautelle-api`, without a tag. */
  name: string;
  /** `sha256:…` of the multi-platform index. */
  digest: string;
  /** The same index on Docker Hub, `docker.io/abegma/nautelle-api` (ADR-0097). */
  mirror?: string;
}

export interface ImagesFile {
  version: string;
  /** Space-separated, as release-images.sh pushed them: `0.16.0 0.16 0 latest`. */
  tags: string;
  /** Comma-separated: `linux/amd64,linux/arm64`. */
  platforms: string;
  images: ImageDigest[];
}

export interface ReleaseNotesInput {
  /** `X.Y.Z`, without the `v`. */
  version: string;
  /** The release note, `docs/releases/vX.Y.Z.md`. */
  note: string;
  images: ImagesFile;
  runnerVersion: string;
}

/** The body of a `## Heading` section, without the heading; null when absent. */
export const section = (markdown: string, heading: string): string | null => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const parseImages = (raw: string): ImagesFile => {
  const parsed: unknown = JSON.parse(raw);
  const value = parsed as Partial<ImagesFile> | null;
  if (
    typeof value?.version !== 'string' ||
    typeof value.tags !== 'string' ||
    typeof value.platforms !== 'string' ||
    !Array.isArray(value.images) ||
    value.images.length === 0 ||
    !value.images.every(
      (image: Partial<ImageDigest>) =>
        typeof image?.name === 'string' &&
        typeof image.digest === 'string' &&
        DIGEST.test(image.digest) &&
        (image.mirror === undefined || typeof image.mirror === 'string'),
    )
  ) {
    throw new Error('images.json does not list an image with a sha256 digest');
  }
  return value as ImagesFile;
};

export const releaseNotes = ({
  version,
  note,
  images,
  runnerVersion,
}: ReleaseNotesInput): string => {
  if (images.version !== version) {
    throw new Error(
      `images.json is for ${images.version}, the release is ${version}`,
    );
  }
  const summary = section(note, 'Summary');
  const changed = section(note, 'What changed');
  if (summary === null || changed === null) {
    throw new Error(
      `docs/releases/v${version}.md needs a "Summary" and a "What changed" section`,
    );
  }
  const tag = `v${version}`;
  const blob = `https://github.com/${REPO}/blob/${tag}`;
  const raw = `https://raw.githubusercontent.com/${REPO}/${tag}`;
  const tags = images.tags
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => `\`${name}\``)
    .join(', ');
  const platforms = images.platforms
    .split(',')
    .map((name) => `\`${name.trim()}\``)
    .join(', ');
  const [first] = images.images;
  const mirrored = images.images.some((image) => image.mirror !== undefined);
  const allInOne = images.images.find((image) =>
    /\/nautelle$/.test(image.name),
  );
  const table = mirrored
    ? [
        '| Image | Docker Hub | Digest |',
        '|---|---|---|',
        ...images.images.map(
          (image) =>
            `| \`${image.name}:${version}\` | ${image.mirror === undefined ? '' : `\`${image.mirror}:${version}\``} | \`${image.digest}\` |`,
        ),
      ]
    : [
        '| Image | Digest |',
        '|---|---|',
        ...images.images.map(
          (image) => `| \`${image.name}:${version}\` | \`${image.digest}\` |`,
        ),
      ];

  return [
    summary,
    '',
    '## What changed',
    '',
    changed,
    '',
    '## Install',
    '',
    '```sh',
    `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/deploy/compose/install.sh | sh -s -- --version ${version}`,
    '```',
    '',
    `To upgrade an install, set \`NAUTELLE_VERSION=${version}\` in \`nautelle/.env\` (or leave it at \`latest\`), then run \`docker compose pull && docker compose up -d\` in \`nautelle/\`. See the [install guide](https://andreybegma.github.io/Nautelle/getting-started/install/) and the [upgrade policy](${blob}/docs/guides/versioning.md).`,
    ...(allInOne === undefined
      ? []
      : [
          '',
          'To try it in one container (a demo database inside, not for production):',
          '',
          '```sh',
          `docker run -p 8000:8000 -v nautelle:/data ${allInOne.mirror ?? allInOne.name}:${version}`,
          '```',
        ]),
    '',
    '## Images',
    '',
    `Platforms: ${platforms}. Tags: ${tags}.`,
    '',
    ...table,
    '',
    mirrored
      ? 'Docker Hub holds the same index, so the same digest. Each image is signed in both registries with the key in `deploy/images/cosign.pub` and carries an SBOM and build provenance:'
      : 'Each image is signed with the key in `deploy/images/cosign.pub` and carries an SBOM and build provenance:',
    '',
    '```sh',
    `curl -fsSLO ${raw}/deploy/images/cosign.pub`,
    `cosign verify --key cosign.pub ${first?.name}@${first?.digest}`,
    `docker buildx imagetools inspect ${first?.name}@${first?.digest} --format '{{ json .SBOM }}'`,
    '```',
    '',
    '## Runner',
    '',
    `This release ships with runner ${runnerVersion}: \`brew install andreybegma/tap/nautelle-runner\` or \`npm i -g nautelle-runner@${runnerVersion}\` ([runner-v${runnerVersion}](https://github.com/${REPO}/releases/tag/runner-v${runnerVersion})).`,
    '',
    `Full release note, with every merged pull request: [docs/releases/${tag}.md](${blob}/docs/releases/${tag}.md).`,
    '',
  ].join('\n');
};

if (import.meta.main) {
  const [tag = process.env.CI_COMMIT_TAG ?? '', out] = process.argv.slice(2);
  const version = tag.replace(/^v/, '');
  try {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`"${tag}" is not a release tag vX.Y.Z`);
    }
    const body = releaseNotes({
      version,
      note: readFileSync(join(root, `docs/releases/v${version}.md`), 'utf8'),
      images: parseImages(
        readFileSync(join(root, '.release/images.json'), 'utf8'),
      ),
      runnerVersion: (
        JSON.parse(
          readFileSync(join(root, 'apps/runner/package.json'), 'utf8'),
        ) as { version: string }
      ).version,
    });
    if (out === undefined) process.stdout.write(body);
    else writeFileSync(out, body);
  } catch (error) {
    console.error(`release-notes: ${(error as Error).message}`);
    process.exit(1);
  }
}
