import {
  dependencyOrder,
  docsPrIssueBody,
  fallbackDocument,
  findCycle,
  rewriteDependsOn,
  type SendTask,
  slugOf,
  specFilePath,
} from './plan-send';

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
