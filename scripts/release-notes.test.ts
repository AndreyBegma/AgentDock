import { describe, expect, test } from 'bun:test';
import { parseImages, releaseNotes, section } from './release-notes';

const API_DIGEST = `sha256:${'a'.repeat(64)}`;
const WEB_DIGEST = `sha256:${'b'.repeat(64)}`;

const NOTE = [
  '# Nautelle v0.16.0',
  '',
  'Released 2026-10-30 · Runner: 0.16.0',
  '',
  '## Summary',
  '',
  'Images for arm64 and a notice when a release is out.',
  '',
  '## What changed',
  '',
  '### New',
  '',
  '- Nautelle runs on arm64 hosts.',
  '',
  '### Fixed',
  '',
  '- A card resumes after a limit.',
  '',
  '## Merged pull requests',
  '',
  '| PR | Title | Classified as |',
  '|---|---|---|',
  '| [#1](https://example.com) | feat | new |',
  '',
  '## Runner',
  '',
  'Runner 0.16.0 ships with this release.',
].join('\n');

const IMAGES = {
  version: '0.16.0',
  tags: '0.16.0 0.16 0 latest',
  platforms: 'linux/amd64,linux/arm64',
  images: [
    { name: 'ghcr.io/andreybegma/nautelle-api', digest: API_DIGEST },
    { name: 'ghcr.io/andreybegma/nautelle-web', digest: WEB_DIGEST },
  ],
};

describe('section', () => {
  test('returns the body up to the next level-two heading', () => {
    expect(section(NOTE, 'What changed')).toBe(
      '### New\n\n- Nautelle runs on arm64 hosts.\n\n### Fixed\n\n- A card resumes after a limit.',
    );
  });

  test('returns the last section to the end', () => {
    expect(section(NOTE, 'Runner')).toBe(
      'Runner 0.16.0 ships with this release.',
    );
  });

  test('is null for a missing or empty section', () => {
    expect(section(NOTE, 'Upgrade')).toBeNull();
    expect(section('## Summary\n\n## Next', 'Summary')).toBeNull();
  });
});

describe('releaseNotes', () => {
  const body = releaseNotes({
    version: '0.16.0',
    note: NOTE,
    images: IMAGES,
    runnerVersion: '0.16.0',
  });

  test('starts with the summary and carries the changes, not the PR table', () => {
    expect(
      body.startsWith('Images for arm64 and a notice when a release is out.'),
    ).toBe(true);
    expect(body).toContain('### New\n\n- Nautelle runs on arm64 hosts.');
    expect(body).toContain('- A card resumes after a limit.');
    expect(body).not.toContain('Merged pull requests');
  });

  test('gives the install command for this version', () => {
    expect(body).toContain(
      'https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh -s -- --version 0.16.0',
    );
  });

  test('lists every image digest and how to verify it', () => {
    expect(body).toContain(
      `| \`ghcr.io/andreybegma/nautelle-api:0.16.0\` | \`${API_DIGEST}\` |`,
    );
    expect(body).toContain(
      `| \`ghcr.io/andreybegma/nautelle-web:0.16.0\` | \`${WEB_DIGEST}\` |`,
    );
    expect(body).toContain(
      `cosign verify --key cosign.pub ghcr.io/andreybegma/nautelle-api@${API_DIGEST}`,
    );
    expect(body).toContain(
      'https://raw.githubusercontent.com/AndreyBegma/Nautelle/v0.16.0/deploy/images/cosign.pub',
    );
    expect(body).toContain('`linux/amd64`, `linux/arm64`');
    expect(body).toContain('`0.16.0`, `0.16`, `0`, `latest`');
  });

  test('names the matching runner version', () => {
    expect(body).toContain('runner 0.16.0');
    expect(body).toContain('npm i -g nautelle-runner@0.16.0');
    expect(body).toContain('/releases/tag/runner-v0.16.0');
  });

  test('refuses digests of another version', () => {
    expect(() =>
      releaseNotes({
        version: '0.16.1',
        note: NOTE,
        images: IMAGES,
        runnerVersion: '0.16.0',
      }),
    ).toThrow('images.json is for 0.16.0');
  });

  test('refuses a note without its summary or changes', () => {
    expect(() =>
      releaseNotes({
        version: '0.16.0',
        note: '# Nautelle v0.16.0\n\n## Summary\n\nText.',
        images: IMAGES,
        runnerVersion: '0.16.0',
      }),
    ).toThrow('"What changed"');
  });
});

describe('parseImages', () => {
  test('reads what release-images.sh writes', () => {
    expect(parseImages(JSON.stringify(IMAGES))).toEqual(IMAGES);
  });

  test('refuses an image without a sha256 digest', () => {
    const broken = {
      ...IMAGES,
      images: [{ name: 'ghcr.io/andreybegma/nautelle-api', digest: '' }],
    };
    expect(() => parseImages(JSON.stringify(broken))).toThrow('sha256');
  });

  test('refuses an empty list', () => {
    expect(() =>
      parseImages(JSON.stringify({ ...IMAGES, images: [] })),
    ).toThrow('sha256');
  });
});
