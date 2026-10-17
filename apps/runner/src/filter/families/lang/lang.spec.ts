import { describe, expect, it } from 'bun:test';
import { langFilters } from '.';
import {
  SEARCH_LINES_PER_FILE,
  SEARCH_MIN_BYTES,
  searchHitText,
} from './files';

const find = (argv: string[]) => langFilters.find((f) => f.matches(argv));
const run = (argv: string[], output: string, exitCode = 0) =>
  find(argv)?.apply({ argv, output, exitCode }) ?? null;
const longRunning = (argv: string[]) =>
  find(argv)?.longRunning?.(argv) ?? false;

const numbered = (n: number, prefix = 'src/file'): string =>
  `${Array.from({ length: n }, (_, i) => `${prefix}${i}.txt`).join('\n')}\n`;

describe('lang filters: which commands they take', () => {
  it.each([
    [['pytest', '-q'], 'lang/pytest'],
    [['python3', '-m', 'pytest', 'tests'], 'lang/pytest'],
    [['uv', 'run', 'pytest'], 'lang/pytest'],
    [['poetry', 'run', 'pytest', '-x'], 'lang/pytest'],
    [['ruff', 'check', '.'], 'lang/ruff'],
    [['pip', 'install', '-r', 'r.txt'], 'lang/pip'],
    [['python', '-m', 'pip', 'install', 'x'], 'lang/pip'],
    [['poetry', 'install'], 'lang/poetry'],
    [['go', 'test', './...'], 'lang/go-test'],
    [['cargo', 'test'], 'lang/cargo'],
    [['cargo', '+nightly', 'clippy'], 'lang/cargo'],
    [['rspec'], 'lang/rspec'],
    [['bundle', 'exec', 'rspec', 'spec/a_spec.rb'], 'lang/rspec'],
    [['bundle', 'exec', 'rubocop'], 'lang/rubocop'],
    [['bundle', 'install'], 'lang/bundle'],
    [['mvn', '-q', 'test'], 'lang/maven'],
    [['mvnw', 'verify'], 'lang/maven'],
    [['gradlew', 'test'], 'lang/gradle'],
    [['dotnet', 'test'], 'lang/dotnet'],
    [['dotnet', 'build', '-c', 'Release'], 'lang/dotnet'],
    [['phpunit'], 'lang/phpunit'],
    [['composer', 'install'], 'lang/composer'],
    [['find', '.', '-name', '*.ts'], 'lang/find'],
    [['ls', '-R'], 'lang/ls'],
    [['tree', '-L', '3'], 'lang/tree'],
    [['rg', 'TODO'], 'lang/search'],
    [['grep', '-rn', 'foo', 'src'], 'lang/search'],
  ])('%j -> %s', (argv, id) => {
    expect(find(argv)?.id).toBe(id);
  });

  it('leaves interactive, structured and uncovered commands alone', () => {
    for (const argv of [
      ['pytest', '--pdb'],
      ['python', 'script.py'],
      ['ruff', 'format', '.'],
      ['pip', 'list'],
      ['go', 'build', './...'],
      ['go', 'test', '-json', './...'],
      ['cargo', 'run'],
      ['cargo', 'install', 'ripgrep'],
      ['dotnet', 'run'],
      ['dotnet', 'watch', 'test'],
      ['bundle', 'exec', 'rails', 'server'],
      ['find', '.', '-name', '*.o', '-delete'],
      ['find', '.', '-type', 'f', '-print0'],
      ['find', '.', '-exec', 'wc', '-l', '{}', ';'],
      ['tree', '-J'],
      ['rg', '--json', 'x'],
      ['cat', 'README.md'],
      ['wc', '-l', 'a'],
    ]) {
      expect({ argv, id: find(argv)?.id }).toEqual({ argv, id: undefined });
    }
  });
});

describe('lang filters: long-running modes', () => {
  it('leaves watch, serve and fuzz modes to run', () => {
    for (const argv of [
      ['ruff', 'check', '--watch', '.'],
      ['pytest', '--looponfail'],
      ['go', 'test', '-fuzz=FuzzParse'],
      ['mvn', 'spring-boot:run'],
      ['mvn', 'quarkus:dev'],
      ['mvn', 'jetty:run'],
      ['gradlew', 'bootRun'],
      ['gradlew', '--continuous', 'test'],
      ['gradle', '-t', 'build'],
      ['gradlew', ':app:run'],
    ]) {
      expect({ argv, longRunning: longRunning(argv) }).toEqual({
        argv,
        longRunning: true,
      });
    }
  });

  it('filters the finite modes', () => {
    for (const argv of [
      ['pytest'],
      ['ruff', 'check', '.'],
      ['go', 'test', './...'],
      ['mvn', 'test'],
      ['mvn', 'clean', 'verify'],
      ['gradlew', 'test'],
    ]) {
      expect({ argv, longRunning: longRunning(argv) }).toEqual({
        argv,
        longRunning: false,
      });
    }
  });
});

describe('lang filters: unclassified output passes through', () => {
  it('returns null for output of a shape it does not know', () => {
    const output = 'something entirely different\nhappened\n';
    for (const argv of [
      ['pytest'],
      ['ruff', 'check'],
      ['pip', 'install', 'x'],
      ['poetry', 'install'],
      ['go', 'test'],
      ['cargo', 'build'],
      ['rspec'],
      ['rubocop'],
      ['bundle', 'install'],
      ['mvn', 'test'],
      ['gradlew', 'test'],
      ['dotnet', 'build'],
      ['phpunit'],
      ['composer', 'install'],
    ]) {
      expect({ argv, result: run(argv, output) }).toEqual({
        argv,
        result: null,
      });
    }
  });

  it('structured and concise output is never rewritten', () => {
    expect(run(['go', 'test'], '{"Action":"run"}\n')).toBe(null);
    expect(run(['ruff', 'check'], '[{"code":"F401"}]\n')).toBe(null);
    expect(
      run(
        ['ruff', 'check'],
        'a.py:1:8: F401 `os` imported but unused\nFound 1 error.\n',
      ),
    ).toBe(null);
  });

  it('short listings are left alone', () => {
    expect(run(['find', '.'], numbered(40))).toBe(null);
    expect(run(['ls', '-R'], numbered(40))).toBe(null);
    expect(run(['rg', 'x'], numbered(40))).toBe(null);
  });
});

describe('lang filters: what stays', () => {
  it('pytest keeps the failing line, its detail and the summary', () => {
    const output = [
      '============================= test session starts ==============================',
      'platform linux -- Python 3.12.3, pytest-8.3.2',
      'collected 3 items',
      '',
      'tests/test_a.py::test_ok PASSED                                          [ 33%]',
      'tests/test_a.py::test_bad FAILED                                         [ 66%]',
      'tests/test_a.py::test_ok2 PASSED                                         [100%]',
      '',
      '=================================== FAILURES ===================================',
      '___________________________________ test_bad ___________________________________',
      '',
      '    def test_bad():',
      '>       assert add(1, 1) == 3',
      'E       assert 2 == 3',
      '',
      'tests/test_a.py:9: AssertionError',
      '=========================== short test summary info ============================',
      'FAILED tests/test_a.py::test_bad - assert 2 == 3',
      '========================= 1 failed, 2 passed in 0.05s ==========================',
      '',
    ].join('\n');
    const result = run(['pytest', '-v'], output, 1) ?? '';
    expect(result).toContain('>       assert add(1, 1) == 3');
    expect(result).toContain('E       assert 2 == 3');
    expect(result).toContain('tests/test_a.py:9: AssertionError');
    expect(result).toContain(
      'FAILED tests/test_a.py::test_bad - assert 2 == 3',
    );
    expect(result).toContain('1 failed, 2 passed in 0.05s');
    expect(result).not.toContain('test_ok PASSED');
    expect(result).not.toContain('platform linux');
  });

  it('go test summarises passing packages and keeps the failing one', () => {
    const output = [
      'ok  \texample.com/a\t0.1s',
      'ok  \texample.com/b\t0.1s',
      'ok  \texample.com/c\t0.1s',
      'ok  \texample.com/d\t0.1s',
      '--- FAIL: TestX (0.00s)',
      '    x_test.go:12: got 1, want 2',
      'FAIL\texample.com/e\t0.2s',
      '?   \texample.com/f\t[no test files]',
      'FAIL',
      '',
    ].join('\n');
    const result = run(['go', 'test', './...'], output, 1) ?? '';
    expect(result).toContain('ok  4 packages passed');
    expect(result).toContain('x_test.go:12: got 1, want 2');
    expect(result).toContain('FAIL\texample.com/e\t0.2s');
    expect(result).not.toContain('no test files');
  });

  it('cargo keeps compiler diagnostics whole and drops Compiling lines', () => {
    const output = [
      '   Compiling a v0.1.0 (/x)',
      'error[E0308]: mismatched types',
      ' --> src/main.rs:3:18',
      '  |',
      '3 |     let x: u32 = "a";',
      '  |            ---   ^^^ expected `u32`, found `&str`',
      '',
      'error: could not compile `a` (bin "a") due to 1 previous error',
      '',
    ].join('\n');
    const result = run(['cargo', 'build'], output, 101) ?? '';
    expect(result).not.toContain('Compiling');
    expect(result).toContain('3 |     let x: u32 = "a";');
    expect(result).toContain(' --> src/main.rs:3:18');
  });

  it('rspec in documentation format keeps a failed example under its group', () => {
    const output = [
      'Invoice',
      '  #total',
      '    sums lines',
      '    rounds (FAILED - 1)',
      '  #paid?',
      '    is false',
      '',
      'Failures:',
      '',
      '  1) Invoice#total rounds',
      '     Failure/Error: expect(1).to eq(2)',
      "     # ./spec/invoice_spec.rb:9:in `block (3 levels)'",
      '',
      'Finished in 0.1 seconds (files took 1 second to load)',
      '3 examples, 1 failure',
      '',
    ].join('\n');
    const result = run(['rspec'], output, 1) ?? '';
    expect(result).toContain('Invoice\n  #total\n    rounds (FAILED - 1)');
    expect(result).not.toContain('sums lines');
    expect(result).not.toContain('is false');
    expect(result).toContain('./spec/invoice_spec.rb:9');
  });

  it('dotnet prints the diagnostics MSBuild repeats once', () => {
    const diagnostic = '/s/A.cs(3,5): error CS1002: ; expected [/s/A.csproj]';
    const output = [
      '  Determining projects to restore...',
      diagnostic,
      '',
      'Build FAILED.',
      '',
      diagnostic,
      '    0 Warning(s)',
      '    1 Error(s)',
      '',
    ].join('\n');
    const result = run(['dotnet', 'build'], output, 1) ?? '';
    expect(result.split(diagnostic).length - 1).toBe(1);
    expect(result).toContain('1 Error(s)');
  });

  it('long listings keep their head and tail and say what they omit', () => {
    const result = run(['find', '.', '-name', '*.txt'], numbered(500)) ?? '';
    expect(result).toContain('src/file0.txt');
    expect(result).toContain('src/file499.txt');
    expect(result).toContain('lines omitted');
    expect(result).not.toContain('src/file250.txt');
  });

  it('a long search keeps every error hit, wherever it is', () => {
    const lines = Array.from(
      { length: 600 },
      (_, i) => `docs/notes${i}.md: remark ${i}`,
    );
    lines.splice(300, 0, "src/app.ts:42:  throw new Error('needle');");
    const result = run(['rg', 'needle'], `${lines.join('\n')}\n`) ?? '';
    expect(result).toContain("src/app.ts:42:  throw new Error('needle');");
    expect(result).toContain('lines omitted');
    expect(result).not.toContain('docs/notes200.md');
  });

  it('search hits are grouped by file and capped per file', () => {
    const lines = [
      ...Array.from(
        { length: 30 },
        (_, i) => `src/store.ts:${i + 1}:  const value${i} = useState(${i});`,
      ),
      'src/store.ts:99:  // TODO: this fails when the cache is empty',
      'src/one.ts:7:const x = useState(0);',
      ...Array.from(
        { length: 5 },
        (_, i) => `src/two.ts:${i + 10}:  useState(${i}),`,
      ),
    ];
    const result = run(
      ['grep', '-rn', 'useState', 'src'],
      `${lines.join('\n')}\n`,
    );
    expect(result).toBe(
      [
        'src/store.ts (31 hits)',
        ...Array.from(
          { length: SEARCH_LINES_PER_FILE },
          (_, i) => `  ${i + 1}:  const value${i} = useState(${i});`,
        ),
        '  99:  // TODO: this fails when the cache is empty',
        `  … ${30 - SEARCH_LINES_PER_FILE} more lines`,
        'src/one.ts:7:const x = useState(0);',
        'src/two.ts (5 hits)',
        ...Array.from({ length: 5 }, (_, i) => `  ${i + 10}:  useState(${i}),`),
        '',
      ].join('\n'),
    );
  });

  it('a hit is judged by its text, not by its file:line prefix', () => {
    expect(searchHitText('src/a.ts:12:  return x;')).toBe('  return x;');
    expect(searchHitText('src/a-1.ts-12-  ctx')).toBe('  ctx');
    expect(searchHitText('src/a.ts:  return x;')).toBe('  return x;');
    expect(searchHitText('grep: dir: Is a directory')).toBe(
      'grep: dir: Is a directory',
    );
  });

  it('a short search, a count and a file list are not grouped', () => {
    const short = 'src/a.ts:1:x\nsrc/a.ts:2:y\n';
    expect(run(['rg', '-n', 'x'], short)).toBe(null);
    const counts = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts:3`);
    expect(run(['rg', '-c', 'x'], `${counts.join('\n')}\n`)).toBe(null);
    const below = `${'src/a.ts:1:x\n'.repeat(Math.floor((SEARCH_MIN_BYTES - 1) / 13))}`;
    expect(Buffer.byteLength(below)).toBeLessThan(SEARCH_MIN_BYTES);
    expect(run(['rg', '-n', 'x'], below)).toBe(null);
  });
});
