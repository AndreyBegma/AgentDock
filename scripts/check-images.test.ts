import { describe, expect, test } from 'bun:test';
import { checkCompose, checkDockerfile } from './check-images';

const ref = (name: string) => `$\{${name}}`;
const D = `@sha256:${'a'.repeat(64)}`;

describe('checkDockerfile', () => {
  test('passes digest-pinned images, resolved build arguments and stages', () => {
    const source = [
      `ARG NODE_IMAGE=node:24-slim${D}`,
      `ARG BUN_IMAGE=oven/bun:1${D}`,
      `FROM ${ref('NODE_IMAGE')} AS deps`,
      `COPY --from=${ref('BUN_IMAGE')} /usr/local/bin/bun /usr/local/bin/bun`,
      'FROM deps AS builder',
      'COPY --from=builder /app /app',
    ].join('\n');
    expect(checkDockerfile(source)).toEqual([]);
  });

  test('fails a FROM without a digest', () => {
    expect(checkDockerfile('FROM node:24-bookworm-slim')).toHaveLength(1);
  });

  test('fails a build argument whose default has no digest', () => {
    const source = `ARG NODE_IMAGE=node:24\nFROM ${ref('NODE_IMAGE')}`;
    expect(checkDockerfile(source)).toHaveLength(1);
  });

  test('fails an unresolvable build argument', () => {
    expect(checkDockerfile(`FROM ${ref('UNKNOWN')}`)).toHaveLength(1);
  });

  test('fails COPY --from an unpinned image', () => {
    expect(checkDockerfile('COPY --from=oven/bun:1 /bun /bun')).toHaveLength(1);
  });

  test('fails a download piped into a shell, across continuations', () => {
    expect(
      checkDockerfile('RUN curl -fsSL https://bun.sh/install | bash'),
    ).toHaveLength(1);
    expect(
      checkDockerfile('RUN curl -fsSL \\\n  https://x.sh | sh -s v1'),
    ).toHaveLength(1);
    expect(
      checkDockerfile('RUN wget -qO- https://x.sh | sudo bash'),
    ).toHaveLength(1);
  });

  test('ignores comments and a curl that is not piped to a shell', () => {
    const source = '# curl x | bash\nRUN curl -fsSL -o /tmp/f https://x';
    expect(checkDockerfile(source)).toEqual([]);
  });
});

describe('checkCompose', () => {
  test('fails an unpinned third-party image, allows local and pinned ones', () => {
    const source = [
      '    image: postgres:16',
      `    image: redis:7${D}`,
      '    image: agentdock-api:staging',
    ].join('\n');
    expect(checkCompose(source)).toHaveLength(1);
  });

  test('allows the published Nautelle images by tag, nothing else of ghcr', () => {
    const source = [
      '    image: ghcr.io/andreybegma/nautelle-api:${NAUTELLE_VERSION:-latest}',
      '    image: ghcr.io/andreybegma/nautelle-web:0.15.0',
      '    image: ghcr.io/andreybegma/other:1',
    ].join('\n');
    expect(checkCompose(source)).toEqual([
      '3: image `ghcr.io/andreybegma/other:1` is not pinned by @sha256:',
    ]);
  });
});
