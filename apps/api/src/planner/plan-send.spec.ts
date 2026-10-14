import {
  dependencyOrder,
  designFilePath,
  docsPrIssueBody,
  fallbackDocument,
  findCycle,
  ISSUE_PLACEHOLDER,
  rewriteDependsOn,
  type SendTask,
  slugOf,
  specFilePath,
  withDesignPath,
} from './plan-send';

describe('design files (spec 223 D16)', () => {
  it('sit under the spec directory, or docs/design without one', () => {
    expect(designFilePath('docs/specs', 12, 'Export CSV', 2)).toBe(
      'docs/specs/12-export-csv/design/2.html',
    );
    expect(designFilePath(null, 12, 'Export CSV', 1)).toBe(
      'docs/design/12-export-csv/1.html',
    );
  });

  it('fills the issue number into the path the write turn named, or adds a Design section', () => {
    const template = designFilePath('docs/specs', ISSUE_PLACEHOLDER, 'X', 1);
    const path = designFilePath('docs/specs', 7, 'X', 1);
    expect(
      withDesignPath(`## Design\n\nSee \`${template}\`.\n`, template, path),
    ).toBe(`## Design\n\nSee \`${path}\`.\n`);
    const added = withDesignPath(
      '## Summary\n\nNo design named.\n',
      template,
      path,
    );
    expect(added).toContain('## Design');
    expect(added).toContain(`\`${path}\``);
  });
});

const task = (key: string, dependsOn: string[] = []): SendTask => ({
  key,
  kind: 'feature',
  title: `Task ${key}`,
  summary: `Summary of ${key}`,
  dependsOn,
  questions: [],
  document: null,
});

describe('findCycle', () => {
  it('is null for a DAG and names the keys along a cycle', () => {
    expect(findCycle([task('a'), task('b', ['a'])])).toBeNull();
    expect(
      findCycle([task('a', ['c']), task('b', ['a']), task('c', ['b'])]),
    ).toEqual(['a', 'c', 'b', 'a']);
    expect(findCycle([task('a', ['a'])])).toEqual(['a', 'a']);
  });

  it('ignores dependencies outside the set', () => {
    expect(findCycle([task('a', ['zz'])])).toBeNull();
  });
});

describe('dependencyOrder', () => {
  it('puts every task after its dependencies, else keeps the plan order', () => {
    expect(
      dependencyOrder([task('t1', ['t3']), task('t2'), task('t3', ['t2'])]),
    ).toEqual(['t2', 't3', 't1']);
    expect(dependencyOrder([task('a'), task('b')])).toEqual(['a', 'b']);
  });
});

describe('rewriteDependsOn', () => {
  const numbers = new Map([
    ['t1', 41],
    ['t10', 50],
  ]);

  it('rewrites task keys on Depends on lines only, whole words', () => {
    const body = [
      'Talks about t1 here.',
      '- **Depends on** `t1` and t10',
      'Depends on t1x',
    ].join('\n');
    expect(rewriteDependsOn(body, ['t1', 't10'], numbers)).toBe(
      [
        'Talks about t1 here.',
        '- **Depends on** #41 and #50',
        'Depends on t1x',
      ].join('\n'),
    );
  });

  it('adds a Depends on line for dependencies the body does not name', () => {
    expect(rewriteDependsOn('## Summary\n\nX\n', ['t1', 't10'], numbers)).toBe(
      '## Summary\n\nX\n\nDepends on #41, #50\n',
    );
  });
});

describe('file names and bodies', () => {
  it('slugs a title to ASCII kebab case', () => {
    expect(slugOf('Café — Export PLANS!')).toBe('cafe-export-plans');
    expect(slugOf('***')).toBe('task');
    expect(specFilePath('docs/specs', 42, 'Export')).toBe(
      'docs/specs/42-export.md',
    );
  });

  it('writes the defaults taken into a fallback document (Q6)', () => {
    const doc = fallbackDocument({
      ...task('t1'),
      questions: [
        {
          id: 'q1',
          title: 'Format',
          question: 'Which format?',
          options: [],
          recommendation: { text: 'CSV', why: 'simplest' },
          blocking: false,
        },
      ],
    });
    expect(doc).toContain('## Summary\n\nSummary of t1');
    expect(doc).toContain(
      '## Open questions\n\n- **Format** — Which format?\n  Default taken: CSV (simplest)',
    );
  });

  it('points a docs_pr feature issue at its specification (Q3)', () => {
    const body = docsPrIssueBody(task('t1'), 'docs/specs', 'docs/plan-abc123');
    expect(body).toContain('`docs/specs/<this issue>-task-t1.md`');
    expect(body).toContain('`docs/plan-abc123`');
  });
});
