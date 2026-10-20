import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkWorkflow, mayRunOn } from './check-ci';

const root = resolve(import.meta.dir, '..');

const load = (path: string) =>
  Bun.YAML.parse(readFileSync(join(root, path), 'utf8')) as Parameters<
    typeof checkWorkflow
  >[1];

describe('mayRunOn', () => {
  test('no condition, or a condition without an event, may run', () => {
    expect(mayRunOn(undefined, 'pull_request')).toBe(true);
    expect(mayRunOn([{ branch: 'develop' } as never], 'pull_request')).toBe(
      true,
    );
  });

  test('an event list runs only on its events', () => {
    expect(mayRunOn([{ event: ['push', 'manual'] }], 'pull_request')).toBe(
      false,
    );
    expect(mayRunOn({ event: 'push' }, 'push')).toBe(true);
    expect(
      mayRunOn([{ event: 'push' }, { event: 'pull_request' }], 'pull_request'),
    ).toBe(true);
  });
});

describe('checkWorkflow', () => {
  // The pipelines as they were before C-105 (F-03, F-04).
  test('fails on the Docker socket and host caches of a pull request', () => {
    const violations = checkWorkflow(
      'pipeline.yml',
      load('scripts/fixtures/pipeline-before-c105.yml'),
    );
    expect(violations).toContain(
      'pipeline.yml: step `ci-image` mounts the Docker socket on a pull request',
    );
    expect(violations).toContain(
      'pipeline.yml: step `install` mounts the host path /home/archi/ci-cache/agentdock/bun on a pull request',
    );
  });

  test('fails on a host cache mounted by a release', () => {
    expect(
      checkWorkflow(
        'release-runner.yml',
        load('scripts/fixtures/release-runner-before-c105.yml'),
      ),
    ).toContain(
      'release-runner.yml: step `install` mounts the host path /home/archi/ci-cache/agentdock/bun on a tag',
    );
  });

  test('fails on a secret or privilege on a pull request', () => {
    expect(
      checkWorkflow('w.yml', {
        steps: [
          {
            name: 'leak',
            privileged: true,
            environment: { TOKEN: { from_secret: 'token' } },
          },
        ],
      }),
    ).toEqual([
      'w.yml: step `leak` is privileged on a pull request',
      'w.yml: step `leak` reads a secret on a pull request',
    ]);
  });

  test('fails on `bun install` without --frozen-lockfile', () => {
    expect(
      checkWorkflow('w.yml', {
        when: [{ event: 'push' }],
        steps: [{ name: 'install', commands: ['bun install'] }],
      }),
    ).toEqual([
      'w.yml: step `install` runs `bun install` without --frozen-lockfile',
    ]);
  });

  test('fails on a command that YAML parsed as a map', () => {
    expect(
      checkWorkflow('w.yml', {
        steps: [
          {
            name: 'npm',
            commands: [{ "npm deprecate x 'Renamed to y": "npm i -g y'" }],
          },
        ],
      }),
    ).toEqual([
      "w.yml: step `npm` has a command that is not a string (quote an item holding ': ')",
    ]);
  });

  test('a socket step limited to push and manual passes', () => {
    expect(
      checkWorkflow('w.yml', {
        steps: [
          {
            name: 'ci-image',
            when: [{ event: ['push', 'manual'] }],
            volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
          },
        ],
      }),
    ).toEqual([]);
  });

  test('the workflows in .woodpecker/ pass', () => {
    for (const file of ['pipeline.yml', 'release-runner.yml']) {
      expect(checkWorkflow(file, load(`.woodpecker/${file}`))).toEqual([]);
    }
  });
});
