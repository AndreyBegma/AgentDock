import { describe, expect, test } from 'bun:test';
import { parseEnvExample, renderReference } from './env-reference';

describe('parseEnvExample', () => {
  test('groups a run of variables under the comment block above it', () => {
    const groups = parseEnvExample(
      [
        '# Terminal timeouts, in seconds.',
        '# Defaults: 900, 14400.',
        '# TERMINAL_IDLE_TIMEOUT_SEC=900',
        '# TERMINAL_MAX_DURATION_SEC=14400',
      ].join('\n'),
    );
    expect(groups).toEqual([
      {
        names: ['TERMINAL_IDLE_TIMEOUT_SEC', 'TERMINAL_MAX_DURATION_SEC'],
        values: ['900', '14400'],
        optional: true,
        description: [
          'Terminal timeouts, in seconds.',
          'Defaults: 900, 14400.',
        ],
      },
    ]);
  });

  test('a comment block followed by a blank line describes nothing', () => {
    const groups = parseEnvExample(
      ['# The file introduction.', '', 'PORT=8180'].join('\n'),
    );
    expect(groups).toEqual([
      { names: ['PORT'], values: ['8180'], optional: false, description: [] },
    ]);
  });

  test('splits set and optional variables but keeps their description', () => {
    const groups = parseEnvExample(
      ['# Speech to text.', 'STT_URL=https://x', '# STT_KEY='].join('\n'),
    );
    expect(groups.map((group) => [group.names, group.optional])).toEqual([
      [['STT_URL'], false],
      [['STT_KEY'], true],
    ]);
    expect(groups[1].description).toEqual(['Speech to text.']);
  });

  test('a new comment after a variable starts a new description', () => {
    const groups = parseEnvExample(
      ['# First.', 'A=1', '# Second.', 'B=2'].join('\n'),
    );
    expect(groups.map((group) => group.description)).toEqual([
      ['First.'],
      ['Second.'],
    ]);
  });

  test('ignores comments that only look like prose', () => {
    expect(parseEnvExample('# Never `true` in production.')).toEqual([]);
  });
});

describe('renderReference', () => {
  const page = renderReference([
    {
      source: { file: 'apps/x/.env.example', title: 'X', intro: 'Intro.' },
      text: [
        '# Pipes | and <tags> are escaped, `a|b` in code stays code.',
        'URL=http://a|b',
        '',
        '# EMPTY=',
      ].join('\n'),
    },
  ]);

  test('renders one table per source with its link', () => {
    expect(page).toContain('## X');
    expect(page).toContain(
      'Intro. Source: [`apps/x/.env.example`](https://github.com/AndreyBegma/Nautelle/blob/develop/apps/x/.env.example).',
    );
  });

  test('escapes table syntax and HTML outside code spans', () => {
    expect(page).toContain(
      '| `URL` | `http://a\\|b` | set | Pipes \\| and &lt;tags&gt; are escaped, `a\\|b` in code stays code. |',
    );
  });

  test('shows an optional variable without a value as a dash', () => {
    expect(page).toContain('| `EMPTY` | — | optional | — |');
  });
});
