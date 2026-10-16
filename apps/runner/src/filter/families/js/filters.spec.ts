import { describe, expect, it } from 'bun:test';
import { missingProtectedLines } from '../../classify';
import { findFilter } from '../../engine';
import { jsFilters } from '.';

const find = (...argv: string[]) => findFilter(jsFilters, argv);
const idOf = (...argv: string[]) => find(...argv)?.id ?? null;
const longRunning = (...argv: string[]) =>
  find(...argv)?.longRunning?.(argv.slice(0)) ?? false;
const ESC = String.fromCharCode(27);

describe('js filters: which command they take', () => {
  it.each([
    [['bun', 'test'], 'js/bun-test'],
    [['jest', '--ci'], 'js/jest'],
    [['npx', 'jest'], 'js/jest'],
    [['bunx', '--bun', 'vitest', 'run'], 'js/vitest'],
    [['pnpm', 'exec', 'tsc', '--noEmit'], 'js/tsc'],
    [['yarn', 'tsc'], 'js/tsc'],
    [['biome', 'check'], 'js/biome'],
    [['prettier', '--write', '.'], 'js/prettier'],
    [['next', 'build'], 'js/next-build'],
    [['prisma', 'migrate', 'deploy'], 'js/prisma'],
    [['turbo', 'run', 'build'], 'js/turbo'],
    [['bun', 'install'], 'js/install'],
    [['npm', 'ci'], 'js/install'],
    [['yarn'], 'js/install'],
    [['pnpm', 'outdated'], 'js/outdated'],
    [['bun', 'run', 'test'], 'js/run-script'],
    [['bun', 'run', '--cwd', 'apps/api', 'test'], 'js/run-script'],
    [['npm', 'test'], 'js/run-script'],
  ])('%j → %s', (argv, id) => {
    expect(idOf(...argv)).toBe(id);
  });

  it.each([
    [['biome', 'lsp-proxy']],
    [['next', 'lint']],
    [['prisma', 'studio']],
    [['npx', 'cowsay']],
    [['bun', 'run']],
    [['git', 'status']],
    [['eslint', 'src']],
  ])('leaves %j alone', (argv) => {
    expect(idOf(...(argv as string[]))).toBeNull();
  });
});

describe('js filters: watchers and servers are left alone', () => {
  it.each([
    [['jest', '--watch']],
    [['bun', 'test', '--watch']],
    [['vitest']],
    [['tsc', '-w']],
    [['tsc', '--watch']],
    [['turbo', 'run', 'dev']],
    [['bun', 'run', 'dev:api']],
    [['npm', 'run', 'test:watch']],
    [['pnpm', 'run', 'start']],
  ])('%j is long-running', (argv) => {
    expect(longRunning(...(argv as string[]))).toBe(true);
  });

  it.each([
    [['jest', '--ci']],
    [['vitest', 'run']],
    [['bun', 'test']],
    [['tsc', '--noEmit']],
    [['bun', 'run', 'test']],
    [['turbo', 'run', 'build']],
  ])('%j is not', (argv) => {
    expect(longRunning(...(argv as string[]))).toBe(false);
  });
});

const apply = (argv: string[], output: string, exitCode = 0) =>
  find(...argv)?.apply({ argv, output, exitCode });

describe('js filters: output they do not recognise comes back unchanged', () => {
  it.each([
    [['jest'], 'something else entirely\n'],
    [['vitest', 'run'], 'Test Suites: 1 passed\n'],
    [['bun', 'test'], 'all good\n'],
    [['tsc', '--noEmit'], ''],
    [['biome', 'check'], 'hello\n'],
    [['next', 'build'], 'hello\n'],
    [['turbo', 'run', 'build'], 'hello\n'],
    [['bun', 'install'], 'hello\n'],
    [['pnpm', 'outdated'], 'hello\n'],
    [['bun', 'run', 'x'], 'hello\n'],
  ])('%j', (argv, output) => {
    expect(apply(argv, output)).toBeNull();
  });
});

describe('js filters: behaviour', () => {
  it('jest keeps a failure and its stack, drops passing suites and the frame', () => {
    const output = [
      'PASS unit src/a.spec.ts',
      'PASS unit src/b.spec.ts',
      'FAIL unit src/c.spec.ts',
      '  ● c › works',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '',
      '    Expected: 3',
      '    Received: 4',
      '',
      '      10 |   const x = 4;',
      '    > 11 |   expect(x).toBe(3);',
      '         |             ^',
      '      12 | });',
      '',
      '      at Object.<anonymous> (c.spec.ts:11:15)',
      '',
      'Test Suites: 1 failed, 2 passed, 3 total',
      'Tests:       1 failed, 5 passed, 6 total',
      '',
    ].join('\n');
    const result = apply(['jest'], output, 1) ?? '';
    expect(result).not.toContain('PASS');
    expect(result).not.toContain('const x = 4');
    expect(result).toContain('FAIL unit src/c.spec.ts');
    expect(result).toContain('> 11 |   expect(x).toBe(3);');
    expect(result).toContain('at Object.<anonymous> (c.spec.ts:11:15)');
    expect(missingProtectedLines(output, result)).toEqual([]);
  });

  it('jest --verbose drops a describe title whose tests all passed', () => {
    const output = [
      'FAIL ./a.test.js',
      '  sum',
      '    ✓ adds 0 (1 ms)',
      '    ✓ adds 1',
      '  spool',
      '    ✕ drops the oldest segment (3 ms)',
      '',
      'Test Suites: 1 failed, 1 total',
      'Tests:       1 failed, 2 passed, 3 total',
      '',
    ].join('\n');
    const result = apply(['jest', '--verbose'], output, 1) ?? '';
    expect(result).not.toContain('sum');
    expect(result).toContain('  spool');
    expect(result).toContain('✕ drops the oldest segment');
  });

  it('jest keeps a console.warn block (a warning is protected)', () => {
    const output = [
      'PASS a.test.js',
      '  console.warn',
      '    profile is deprecated',
      '',
      '      at Object.warn (b.test.js:8:13)',
      '',
      'Test Suites: 1 passed, 1 total',
      'Tests:       1 passed, 1 total',
      '',
    ].join('\n');
    const result = apply(['jest'], output) ?? output;
    expect(result).toContain('console.warn');
    expect(result).toContain('profile is deprecated');
  });

  it('vitest drops passing files and the source frame, shortens Duration', () => {
    const output = [
      ' RUN  v3.2.4 /x',
      ' ✓ src/a.test.ts (3 tests) 4ms',
      ' ❯ src/b.test.ts (2 tests | 1 failed) 8ms',
      '   × fails 2ms',
      ' FAIL  src/b.test.ts > fails',
      'AssertionError: expected 1 to be 2',
      ' ❯ src/b.test.ts:10:20',
      '      9|   it(',
      '     10|     expect(1).toBe(2)',
      '       |                    ^',
      '',
      ' Test Files  1 failed | 1 passed (2)',
      '      Tests  1 failed | 3 passed (4)',
      '   Duration  1.2s (transform 1s, setup 0ms)',
      '',
    ].join('\n');
    const result = apply(['vitest', 'run'], output, 1) ?? '';
    expect(result).not.toContain('a.test.ts (3 tests)');
    expect(result).not.toContain('toBe(2)');
    expect(result).toContain('❯ src/b.test.ts:10:20');
    expect(result).toContain('Duration  1.2s\n');
    expect(missingProtectedLines(output, result)).toEqual([]);
  });

  it('bun test drops (pass) lines and the file header they leave empty', () => {
    const output = [
      'bun test v1.3.9 (x)',
      '',
      'src/a.test.ts:',
      '(pass) a > one [0.1ms]',
      '',
      'src/b.test.ts:',
      '(fail) b > two [0.2ms]',
      '',
      ' 1 pass',
      ' 1 fail',
      'Ran 2 tests across 2 files. [3.00ms]',
      '',
    ].join('\n');
    const result = apply(['bun', 'test'], output, 1) ?? '';
    expect(result).not.toContain('src/a.test.ts:');
    expect(result).toContain('src/b.test.ts:');
    expect(result).toContain('(fail) b > two');
  });

  it('tsc keeps the first and last line of a long elaboration chain', () => {
    const output = [
      "a.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.",
      "  Types of property 'x' are incompatible.",
      "    Type 'string' is not assignable to type 'number'.",
      "      Type 'undefined' is not assignable to type 'number'.",
      "b.ts(2,2): error TS2304: Cannot find name 'y'.",
      '',
    ].join('\n');
    const result = apply(['tsc'], output, 2) ?? '';
    expect(result).not.toContain(
      "Type 'string' is not assignable to type 'number'",
    );
    expect(result).toContain("Types of property 'x' are incompatible");
    expect(result).toContain('a.ts(1,1): error TS2322');
    expect(result).toContain("Type 'undefined' is not assignable");
  });

  it('tsc --pretty drops the snippet and the underline but keeps the error', () => {
    const output = [
      `${ESC}[96mbad.ts${ESC}[0m:${ESC}[93m9${ESC}[0m:${ESC}[93m14${ESC}[0m - ${ESC}[91merror${ESC}[0m${ESC}[90m TS2339: ${ESC}[0mProperty 'size' does not exist.`,
      '',
      `${ESC}[7m9${ESC}[0m     sum += s.size;`,
      `${ESC}[7m ${ESC}[0m ${ESC}[91m             ~~~~${ESC}[0m`,
      '',
      'Found 1 error in bad.ts:9',
      '',
    ].join('\n');
    const result = apply(['tsc', '--pretty'], output, 2) ?? '';
    expect(result).not.toContain('sum += s.size');
    expect(result).not.toContain('~~~~');
    expect(result).toContain("Property 'size' does not exist.");
  });

  it('biome keeps the header, the message and the marked line, drops the fix diff', () => {
    const output = [
      'lint.ts:5:3 lint/suspicious/noDebugger  FIXABLE  ━━━━━━━━━━━━━',
      '',
      '  × This is an unexpected use of the debugger statement.',
      '  ',
      '    4 │   const unused = 3',
      '  > 5 │   debugger',
      '      │   ^^^^^^^^',
      '  ',
      '  i Unsafe fix: Remove debugger statement',
      '  ',
      '    4 4 │     const unused = 3',
      '    5   │ - ··debugger',
      '',
      'Checked 1 file in 3ms. No fixes applied.',
      'Found 1 error.',
      '',
    ].join('\n');
    const result = apply(['biome', 'check'], output, 1) ?? '';
    expect(result).toContain('lint.ts:5:3');
    expect(result).toContain('× This is an unexpected use');
    expect(result).toContain('> 5 │   debugger');
    expect(result).toContain('i Unsafe fix: Remove debugger statement');
    expect(result).not.toContain('const unused');
    expect(result).not.toContain('- ··debugger');
    expect(result).toContain('Found 1 error.');
  });

  it('prettier --write drops unchanged files and keeps rewritten ones', () => {
    const output = 'a.ts 4ms (unchanged)\nb.ts 9ms\nc.ts 3ms (unchanged)\n';
    expect(apply(['prettier', '--write', '.'], output)).toBe('b.ts 9ms\n');
  });

  it('prettier --check has nothing to drop', () => {
    const output =
      'Checking formatting...\n[warn] a.ts\n[warn] Code style issues found in the above file.\n';
    expect(apply(['prettier', '--check', '.'], output, 1)).toBeNull();
  });

  it('next build drops the route table but keeps the legend and warnings', () => {
    const output = [
      '▲ Next.js 16.2.3 (Turbopack)',
      '✓ Compiled successfully in 12.7s',
      '⚠ Using edge runtime disables static generation',
      'Route (app)',
      '┌ ƒ /',
      '├ ○ /login',
      '└ ƒ /work',
      '',
      '○  (Static)   prerendered as static content',
      '',
    ].join('\n');
    const result = apply(['next', 'build'], output) ?? '';
    expect(result).not.toContain('/login');
    expect(result).toContain('Route (app)');
    expect(result).toContain('⚠ Using edge runtime');
    expect(result).toContain('(Static)');
  });

  it('install drops the added-package list, funding and upgrade notices', () => {
    const output = [
      'bun install v1.4.0 (x)',
      '',
      '+ typescript@6.0.2',
      '+ zod@4.1.12',
      '',
      '941 packages installed [1.96s]',
      '',
    ].join('\n');
    const result = apply(['bun', 'install'], output) ?? '';
    expect(result).not.toContain('+ zod');
    expect(result).toContain('941 packages installed');
    const npm = [
      'npm warn deprecated glob@7.2.3: no longer supported',
      'added 5 packages in 2s',
      '3 packages are looking for funding',
      '  run `npm fund` for details',
      'npm notice New major version of npm available! 10 -> 11',
      '',
    ].join('\n');
    const kept = apply(['npm', 'install'], npm) ?? '';
    expect(kept).toContain('npm warn deprecated glob@7.2.3');
    expect(kept).toContain('added 5 packages');
    expect(kept).not.toContain('funding');
    expect(kept).not.toContain('npm notice');
  });

  it('outdated squeezes the padding and the borders, never a deprecated row', () => {
    const output = [
      'bun outdated v1.4.0 (x)',
      '|-----------|---------|--------|--------|',
      '| Package   | Current | Update | Latest |',
      '|-----------|---------|--------|--------|',
      '| zod       | 4.1.12  | 4.1.13 | 4.1.13 |',
      '| request   | 2.88.2  | 2.88.2 | 2.88.2   deprecated |',
      '|-----------|---------|--------|--------|',
      '',
    ].join('\n');
    const result = apply(['bun', 'outdated'], output) ?? '';
    expect(result).not.toContain('|----');
    expect(result).toContain('| zod | 4.1.12 | 4.1.13 | 4.1.13 |');
    expect(result).toContain(
      '| request   | 2.88.2  | 2.88.2 | 2.88.2   deprecated |',
    );
  });

  it('a script run applies whichever tool printed the output', () => {
    const output = [
      '$ jest',
      'PASS a.spec.ts',
      'PASS b.spec.ts',
      'Test Suites: 2 passed, 2 total',
      'Tests:       4 passed, 4 total',
      'Snapshots:   0 total',
      '',
    ].join('\n');
    const result = apply(['bun', 'run', 'test'], output) ?? '';
    expect(result).not.toContain('PASS');
    expect(result).toContain('Tests:       4 passed, 4 total');
  });
});
