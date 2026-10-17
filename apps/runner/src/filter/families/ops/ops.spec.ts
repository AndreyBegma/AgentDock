import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { loadCorpus, runCorpusCase } from '../../corpus';
import type { Filter } from '../../types';
import { opsFilters } from '.';
import { GH_MIN_BYTES } from './forge';
import { GIT_MIN_BYTES } from './git';

const run = (argv: string[], output: string, exitCode = 0) => {
  const filter = opsFilters.find((f) => f.matches(argv));
  return filter?.apply({ argv, output, exitCode }) ?? null;
};

const longRunning = (argv: string[]) =>
  opsFilters.find((f) => f.matches(argv))?.longRunning?.(argv) ?? false;

const match = (argv: string[]): string | undefined =>
  opsFilters.find((f: Filter) => f.matches(argv))?.id;

describe('ops filters: which commands they take', () => {
  it.each([
    [['git', 'status'], 'ops/git'],
    [['git', '-C', '/repo', 'log', '-n', '3'], 'ops/git'],
    [['gh', 'pr', 'checks', '12'], 'ops/gh'],
    [['gh', '-R', 'a/b', 'run', 'list'], 'ops/gh'],
    [['glab', 'mr', 'list'], 'ops/glab'],
    [['docker', 'build', '.'], 'ops/docker'],
    [['docker', 'compose', '-f', 'x.yml', 'logs', 'api'], 'ops/docker'],
    [['docker-compose', 'up', '-d'], 'ops/docker'],
    [['kubectl', '-n', 'prod', 'get', 'pods'], 'ops/kubectl'],
    [['helm', 'upgrade', '--install', 'x', './chart'], 'ops/helm'],
    [['terraform', 'plan'], 'ops/terraform'],
    [['aws', 's3', 'sync', 'a', 'b'], 'ops/aws'],
    [['gcloud', 'builds', 'submit'], 'ops/gcloud'],
    [['make', 'build'], 'ops/make'],
    [['curl', '-sS', 'https://x'], 'ops/curl'],
  ])('%j -> %s', (argv, id) => {
    expect(match(argv)).toBe(id);
  });

  it('leaves interactive and uncovered commands alone', () => {
    for (const argv of [
      ['git', 'commit', '-m', 'x'],
      ['git', 'rebase', '-i', 'HEAD~3'],
      ['docker', 'run', '-it', 'alpine', 'sh'],
      ['docker', 'exec', 'web', 'sh'],
      ['docker', 'compose', 'run', 'api', 'sh'],
      ['kubectl', 'exec', '-it', 'pod', '--', 'sh'],
      ['kubectl', 'port-forward', 'svc/api', '8080'],
      ['gh', 'pr', 'create'],
      ['aws', 'ec2', 'describe-instances'],
      ['gcloud', 'auth', 'login'],
      ['terraform', 'console'],
    ]) {
      expect({ argv, id: match(argv) }).toEqual({ argv, id: undefined });
    }
  });
});

describe('ops filters: long-running modes', () => {
  it('leaves follow, watch and attached modes to run', () => {
    for (const argv of [
      ['docker', 'logs', '-f', 'web'],
      ['docker', 'compose', 'logs', '--follow'],
      ['docker', 'compose', 'up'],
      ['docker-compose', 'up', '--build'],
      ['kubectl', 'logs', '-f', 'pod'],
      ['kubectl', 'get', 'pods', '-w'],
      ['terraform', 'apply'],
      ['terraform', 'destroy'],
      ['aws', 'logs', 'tail', '/ecs/x', '--follow'],
      ['gcloud', 'builds', 'log', '--stream', 'abc'],
      ['make', 'dev'],
      ['curl', '-N', 'https://x/events'],
    ]) {
      expect({ argv, longRunning: longRunning(argv) }).toEqual({
        argv,
        longRunning: true,
      });
    }
  });

  it('filters the finite modes', () => {
    for (const argv of [
      ['docker', 'logs', 'web'],
      ['docker', 'compose', 'up', '-d'],
      ['terraform', 'apply', '-auto-approve'],
      ['terraform', 'plan'],
      ['make', 'build'],
    ]) {
      expect({ argv, longRunning: longRunning(argv) }).toEqual({
        argv,
        longRunning: false,
      });
    }
  });
});

describe('ops filters: unclassified output passes through', () => {
  it('git log in an unknown shape is never reformatted by guesswork', () => {
    // a long one is only capped; the engine counts a short one passedThrough
    const output = `commit abc1234\n${'something unexpected\n'.repeat(40)}`;
    expect(run(['git', 'log'], output)).toBe(
      'commit abc1234\nsomething unexpected  [×40]\n',
    );
  });

  it('output below each threshold is left alone', () => {
    // one byte short of each threshold, newline included
    const below = (n: number) => `${'x'.repeat(n - 2)}\n`;
    expect(run(['git', 'status'], below(GIT_MIN_BYTES))).toBe(null);
    expect(run(['git', 'diff'], below(GIT_MIN_BYTES))).toBe(null);
    expect(run(['gh', 'pr', 'view', '1'], below(GH_MIN_BYTES))).toBe(null);
  });

  it('porcelain status and gh json are never reshaped', () => {
    const porcelain = ' M src/a.ts\n'.repeat(200);
    expect(run(['git', 'status', '--porcelain'], porcelain)).toBe(null);
    const json = `[${'{"name":"a","state":"SUCCESS"},'.repeat(40)}{}]\n`;
    expect(run(['gh', 'pr', 'checks', '--json', 'name,state'], json)).toBe(
      null,
    );
    expect(run(['gh', 'pr', 'view', '1'], json)).toBe(null);
  });

  it('a BuildKit build is not shortened: its `#N` lines read as frames', () => {
    expect(
      run(
        ['docker', 'build', '.'],
        '#1 [internal] load build definition\n#1 DONE 0.0s\n',
      ),
    ).toBe(null);
  });

  it('a kubectl log keeps its tail and every error, and elides the middle', () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `t${i} INFO  request ${i} served`,
    );
    lines.splice(200, 0, 't200 ERROR upstream refused the connection');
    const result = run(['kubectl', 'logs', 'api-0'], `${lines.join('\n')}\n`);
    expect(result).toContain('t200 ERROR upstream refused the connection');
    expect(result).toContain('request 399 served');
    expect(result).toContain('lines omitted');
  });

  it('structured kubectl output is never shortened', () => {
    const json = `{"items":[${'{"a":1},'.repeat(200)}{}]}`;
    expect(run(['kubectl', 'get', 'pods', '-o', 'json'], json)).toBe(null);
    expect(run(['kubectl', 'get', 'pods'], json)).toBe(null);
  });

  it('gcloud json is never shortened', () => {
    expect(run(['gcloud', 'run', 'services', 'list'], '[\n{}\n]\n')).toBe(null);
  });

  it('docker build without step markers', () => {
    expect(run(['docker', 'build', '.'], 'something else\n')).toBe(null);
  });

  it('a short s3 copy', () => {
    expect(
      run(['aws', 's3', 'cp', 'a', 's3://b/a'], 'upload: a to s3://b/a\n'),
    ).toBe(null);
  });
});

describe('ops filters: what stays', () => {
  it('git log keeps a protected body line', () => {
    const output = [
      'commit 0123456789abcdef0123456789abcdef01234567',
      'Author: A <a@b.c>',
      'Date:   Fri Oct 16 15:34:15 2026 +0200',
      '',
      '    fix: crash',
      '',
      '    The error was a missing await.',
      '    Unrelated prose.',
      ...Array.from(
        { length: 10 },
        (_, i) => `    More prose about why this changed, line ${i}.`,
      ),
      '',
    ].join('\n');
    const result = run(['git', 'log'], output);
    expect(result).toContain('0123456 ');
    expect(result).toContain('fix: crash');
    expect(result).toContain('The error was a missing await.');
    expect(result).not.toContain('Unrelated prose.');
  });

  it('git diff: a stat header, the hunks, one line of context', () => {
    const body = Array.from({ length: 20 }, (_, i) => ` line ${i}`);
    body.push(...Array.from({ length: 30 }, (_, i) => ` tail ${i}`));
    body.splice(10, 0, '-old ten', '+new ten');
    const result = run(
      ['git', 'diff'],
      [
        'diff --git a/x.ts b/x.ts',
        'index 1111111..2222222 100644',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,51 +1,51 @@ export const x = () => {',
        ...body,
        '',
      ].join('\n'),
    );
    expect(result).toBe(
      [
        '1 file changed, +1 -1',
        ' x.ts | +1 -1',
        '',
        'diff --git a/x.ts b/x.ts',
        '@@ -1,51 +1,51 @@ export const x = () => {',
        '… 9 unchanged lines',
        ' line 9',
        '-old ten',
        '+new ten',
        ' line 10',
        '… 39 unchanged lines',
        '',
      ].join('\n'),
    );
  });

  it('git diff caps a long hunk but keeps its error lines', () => {
    const added = Array.from({ length: 300 }, (_, i) => `+const v${i} = ${i};`);
    added[150] = "+throw new Error('boom');";
    const result =
      run(
        ['git', 'diff'],
        [
          'diff --git a/new.ts b/new.ts',
          'new file mode 100644',
          'index 0000000..2222222',
          '--- /dev/null',
          '+++ b/new.ts',
          '@@ -0,0 +1,300 @@',
          ...added,
          '',
        ].join('\n'),
      ) ?? '';
    expect(result).toContain(' new.ts | +300 -0 (new)');
    expect(result).toContain("+throw new Error('boom');");
    expect(result).toContain('+const v299 = 299;');
    expect(result).not.toContain('+const v100 = 100;');
    expect(result).toContain('lines omitted');
  });

  it('git diff keeps a header line the classifier protects', () => {
    const result =
      run(
        ['git', 'diff'],
        [
          'diff --git a/src/errors.ts b/src/errors.ts',
          'index 1111111..2222222 100644',
          '--- a/src/errors.ts',
          '+++ b/src/errors.ts',
          '@@ -1,3 +1,3 @@',
          ...Array.from(
            { length: 30 },
            (_, i) => `+export const e${i} = ${i};`,
          ),
          '',
        ].join('\n'),
      ) ?? '';
    expect(result).toContain('--- a/src/errors.ts');
    expect(result).toContain('+++ b/src/errors.ts');
    expect(result).not.toContain('index 1111111');
  });

  it('git status becomes a summary per section, capped', () => {
    const output = [
      'On branch feat/x',
      "Your branch is ahead of 'origin/feat/x' by 2 commits.",
      '',
      'Changes to be committed:',
      '  (use "git restore --staged <file>..." to unstage)',
      '\tmodified:   src/a.ts',
      '\tnew file:   src/b.ts',
      '',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '\tmodified:   src/errors.ts',
      '',
      'Untracked files:',
      '  (use "git add <file>..." to include in what will be committed)',
      ...Array.from({ length: 30 }, (_, i) => `\tgen/file${i}.ts`),
      '',
      'no changes added to commit (use "git add" and/or "git commit -a")',
      '',
    ].join('\n');
    const result = run(['git', 'status'], output) ?? '';
    expect(result).toContain('On branch feat/x');
    expect(result).toContain('Staged (2):\n  M src/a.ts\n  A src/b.ts\n');
    expect(result).toContain('Not staged (1):\n  modified:   src/errors.ts\n');
    expect(result).toContain('Untracked (30):\n  ? gen/file0.ts\n');
    expect(result).toContain('  ? gen/file19.ts\n  … 10 more\n');
    expect(result).not.toContain('gen/file20.ts');
    expect(result).not.toContain('  (use "git');
  });

  it('terraform keeps the plan and drops the refresh noise', () => {
    const result = run(
      ['terraform', 'plan'],
      [
        'aws_vpc.main: Refreshing state... [id=vpc-1]',
        '  # aws_vpc.main will be updated in-place',
        '  ~ cidr_block = "10.0.0.0/16" -> "10.1.0.0/16"',
        'Plan: 0 to add, 1 to change, 0 to destroy.',
        '',
      ].join('\n'),
    );
    expect(result).not.toContain('Refreshing');
    expect(result).toContain('will be updated in-place');
    expect(result).toContain('Plan: 0 to add, 1 to change, 0 to destroy.');
  });

  it('gh checks keeps every non-passing row and counts the rest', () => {
    const rows = [
      'a\tpass\t1s\thttps://x/1',
      'b\tpass\t1s\thttps://x/2',
      'c\tpass\t1s\thttps://x/3',
      'd\tpending\t0\thttps://x/4',
      'e\tfail\t9s\thttps://x/5',
      ...Array.from(
        { length: 20 },
        (_, i) => `p${i}\tpass\t1s\thttps://x/p${i}`,
      ),
    ];
    const result = run(['gh', 'pr', 'checks'], `${rows.join('\n')}\n`);
    expect(result).toContain('d\tpending');
    expect(result).toContain('e\tfail');
    expect(result).toContain('23 checks passing or skipped');
  });

  it('kubectl apply counts unchanged objects', () => {
    const output = [
      'a/one unchanged',
      'a/two unchanged',
      'a/three unchanged',
      'a/four configured',
      '',
    ].join('\n');
    const result = run(['kubectl', 'apply', '-f', '.'], output);
    expect(result).toContain('a/four configured');
    expect(result).toContain('3 objects unchanged');
  });

  it('elides a long make log but keeps its errors and the end', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `cc -c src/f${i}.c`);
    lines.splice(150, 0, 'src/f150.c:9:3: error: expected ‘;’');
    const result = run(
      ['make'],
      `${lines.join('\n')}\nmake: *** [all] Error 1\n`,
    );
    expect(result).toContain('src/f150.c:9:3: error: expected ‘;’');
    expect(result).toContain('make: *** [all] Error 1');
    expect(result).toContain('lines omitted');
    expect(result?.split('\n').length).toBeLessThan(120);
  });

  it('curl keeps the body and the failure of a verbose call', () => {
    const output = [
      '* Host example.com:443 was resolved.',
      '> GET /missing HTTP/2',
      '> Host: example.com',
      '> User-Agent: curl/8',
      '< HTTP/2 404 ',
      '< content-type: application/json',
      '< cf-ray: abc',
      '{"error":"not found"}',
      '',
    ].join('\n');
    const result = run(['curl', '-v', 'https://example.com/missing'], output);
    expect(result).toContain('< HTTP/2 404');
    expect(result).toContain('{"error":"not found"}');
    expect(result).not.toContain('cf-ray');
    expect(result).not.toContain('User-Agent');
  });

  it('a carriage-return progress meter keeps its last state', () => {
    const result = run(
      ['git', 'fetch'],
      `Receiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.\nFrom github.com:a/b\n${' * [new branch]      feat/some-branch -> origin/feat/some-branch\n'.repeat(10)}`,
    );
    expect(result).not.toContain('Receiving objects');
    expect(result).toContain('From github.com:a/b');
  });
});

describe('ops corpus', () => {
  const cases = loadCorpus(join(import.meta.dir, 'corpus'));

  it('has cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it('every case a filter is written for is filtered, and keeps its errors', () => {
    for (const c of cases) {
      const r = runCorpusCase(opsFilters, c);
      expect({ name: c.name, missing: r.missing }).toEqual({
        name: c.name,
        missing: [],
      });
      if (c.expect === 'filtered') {
        expect({ name: c.name, filtered: r.filtered }).toEqual({
          name: c.name,
          filtered: true,
        });
      }
    }
  });
});
