import { describe, expect, test } from 'bun:test';
import { checkNumbering } from './check-numbering';

const readme = (...numbers: string[]) =>
  [
    '# Architecture decision records',
    '',
    '| ADR | Decision |',
    '|---|---|',
    ...numbers.map((n) => `| [${n}](${n}-x.md) | Decision ${n} |`),
  ].join('\n');

const clean = {
  migrations: ['20261007183535_init', '20261008000000_auth'],
  adrFiles: ['0001-first.md', '0002-second.md', 'README.md'],
  adrReadme: readme('0001', '0002'),
  knownDuplicateMigrations: new Set<string>(),
};

describe('checkNumbering', () => {
  test('passes unique numbers and a matching index', () => {
    expect(checkNumbering(clean)).toEqual([]);
  });

  test('fails a duplicate migration prefix and names both paths', () => {
    const violations = checkNumbering({
      ...clean,
      migrations: [
        ...clean.migrations,
        '20261231000020_one',
        '20261231000020_two',
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'apps/api/prisma/migrations/20261231000020_one',
    );
    expect(violations[0]).toContain(
      'apps/api/prisma/migrations/20261231000020_two',
    );
    expect(violations[0]).toContain('origin/develop');
  });

  test('accepts a known duplicate group but not a new member of it', () => {
    const known = new Set(['20261206000000_a', '20261206000000_b']);
    const input = {
      ...clean,
      migrations: [...clean.migrations, ...known],
      knownDuplicateMigrations: known,
    };
    expect(checkNumbering(input)).toEqual([]);
    expect(
      checkNumbering({
        ...input,
        migrations: [...input.migrations, '20261206000000_c'],
      }),
    ).toHaveLength(1);
  });

  test('fails a duplicate ADR number and names both paths', () => {
    const violations = checkNumbering({
      ...clean,
      adrFiles: [...clean.adrFiles, '0002-other.md'],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('docs/adr/0002-other.md');
    expect(violations[0]).toContain('docs/adr/0002-second.md');
    expect(violations[0]).toContain('origin/develop');
  });

  test('fails an index row without a file', () => {
    const violations = checkNumbering({
      ...clean,
      adrReadme: readme('0001', '0002', '0003'),
    });
    expect(violations).toEqual([
      'docs/adr/README.md has a row for ADR 0003 but no docs/adr/0003-*.md file exists',
    ]);
  });

  test('fails a file without an index row', () => {
    const violations = checkNumbering({
      ...clean,
      adrFiles: [...clean.adrFiles, '0003-third.md'],
    });
    expect(violations).toEqual([
      'docs/adr/0003-third.md has no row in docs/adr/README.md; add one',
    ]);
  });
});
