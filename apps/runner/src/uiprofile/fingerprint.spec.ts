import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type UiProfileFingerprintArgs,
  uiProfileFingerprintArgsSchema,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { skillsWorkspace } from '../skills/testing';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { fingerprint, globToRegExp } from './fingerprint';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const setup = async () => {
  const f = await skillsWorkspace();
  teardown.push(f.cleanup);
  f.write(f.root, {
    'package.json': '{"name":"widget"}\n',
    'tailwind.config.ts': 'export default {}\n',
    'src/app/globals.css': 'body{}\n',
    'src/components/Button.tsx': 'export const Button = 1;\n',
    'src/components/ui/Card.tsx': 'export const Card = 1;\n',
    'src/lib/util.ts': 'export {};\n',
  });
  await f.commitAll(f.root, 'ui');
  await f.run(f.root, 'push', '-q', 'origin', 'main');
  const deps = { exec: f.git, watchedProjects: () => [f.project] };
  const args = (
    globs: string[],
    overrides: Partial<UiProfileFingerprintArgs> = {},
  ): UiProfileFingerprintArgs => ({
    projectId: f.project.id,
    root: f.root,
    base: 'main',
    globs,
    ...overrides,
  });
  return { f, deps, args };
};

const codeOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandFailure);
  return (error as CommandFailure).code;
};

describe('globToRegExp', () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

  it('keeps * inside a segment and lets ** cross directories', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matches('src/**/*.tsx', 'src/components/ui/Card.tsx')).toBe(true);
    expect(matches('src/**/*.tsx', 'src/Top.tsx')).toBe(true);
    expect(matches('**/*.css', 'src/app/globals.css')).toBe(true);
    expect(matches('src/**', 'src/a/b/c')).toBe(true);
  });

  it('supports ?, alternation, and treats other characters literally', () => {
    expect(matches('a?.ts', 'ab.ts')).toBe(true);
    expect(matches('a?.ts', 'a/.ts')).toBe(false);
    expect(matches('*.{css,scss}', 'x.scss')).toBe(true);
    expect(matches('*.{css,scss}', 'x.less')).toBe(false);
    expect(matches('a.b', 'axb')).toBe(false);
    expect(matches('(x)+.ts', '(x)+.ts')).toBe(true);
    expect(matches('{unclosed', '{unclosed')).toBe(true);
  });
});

describe('uiprofile.fingerprint (D13)', () => {
  it('hashes the matching files and counts them', async () => {
    const { deps, args } = await setup();
    const result = await fingerprint(args(['src/components/**/*.tsx']), deps);
    expect(result.files).toBe(2);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Glob order and duplicates do not matter: the lines are sorted.
    const twice = await fingerprint(
      args(['src/components/ui/*.tsx', 'src/components/*.tsx']),
      deps,
    );
    expect(twice).toEqual(result);
  });

  it('changes when a matching file changes on origin and not when another does', async () => {
    const { f, deps, args } = await setup();
    const before = await fingerprint(args(['src/components/**']), deps);

    f.write(f.root, { 'src/lib/util.ts': 'export const x = 1;\n' });
    await f.commitAll(f.root, 'unrelated');
    await f.run(f.root, 'push', '-q', 'origin', 'main');
    expect(await fingerprint(args(['src/components/**']), deps)).toEqual(
      before,
    );

    f.write(f.root, {
      'src/components/Button.tsx': 'export const Button = 2;\n',
    });
    await f.commitAll(f.root, 'button');
    await f.run(f.root, 'push', '-q', 'origin', 'main');
    const after = await fingerprint(args(['src/components/**']), deps);
    expect(after.files).toBe(before.files);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('reads blobs from origin/<base>, not the working copy', async () => {
    const { f, deps, args } = await setup();
    const globs = ['src/components/**'];
    const before = await fingerprint(args(globs), deps);

    // Edited and deleted in the working copy, and committed locally but not pushed.
    f.write(f.root, { 'src/components/Button.tsx': 'local edit\n' });
    rmSync(join(f.root, 'src/components/ui/Card.tsx'));
    writeFileSync(join(f.root, 'src/components/New.tsx'), 'untracked\n');
    expect(await fingerprint(args(globs), deps)).toEqual(before);
    await f.commitAll(f.root, 'local only');
    expect(await fingerprint(args(globs), deps)).toEqual(before);
  });

  it('refuses a glob with .. or an absolute path', async () => {
    const { deps, args } = await setup();
    for (const glob of [
      '../secrets/**',
      'src/../../etc/passwd',
      '/etc/passwd',
      'C:/Windows/**',
      'src\\**',
    ]) {
      expect(await codeOf(fingerprint(args([glob]), deps))).toBe(
        'path_not_allowed',
      );
      // The schema refuses it too: it never reaches the handler off the wire.
      expect(
        uiProfileFingerprintArgsSchema.safeParse(args([glob])).success,
      ).toBe(false);
    }
  });

  it('refuses a project that is not watched and a base origin does not have', async () => {
    const { deps, args } = await setup();
    expect(
      await codeOf(fingerprint(args(['**'], { root: '/elsewhere' }), deps)),
    ).toBe('path_not_allowed');
    expect(
      await codeOf(fingerprint(args(['**'], { base: 'nope' }), deps)),
    ).toBe('not_found');
  });

  it('is too_large past 2 000 files', async () => {
    const { f, deps, args } = await setup();
    const many: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) many[`gen/f${i}.txt`] = `${i}\n`;
    f.write(f.root, many);
    await f.commitAll(f.root, 'many');
    await f.run(f.root, 'push', '-q', 'origin', 'main');
    expect(await codeOf(fingerprint(args(['gen/**']), deps))).toBe('too_large');
    expect((await fingerprint(args(['gen/f1*.txt']), deps)).files).toBe(1111);
  });
});
