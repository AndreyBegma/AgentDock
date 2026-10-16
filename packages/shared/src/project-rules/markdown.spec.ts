import { describe, expect, it } from 'bun:test';
import {
  PROJECT_RULE_DESCRIPTION_MAX,
  PROJECT_RULE_TITLE_MAX,
} from './contracts';
import { parseRulesMarkdown, ruleTitleKey } from './markdown';

describe('parseRulesMarkdown (#528)', () => {
  describe('empty input', () => {
    it.each([
      '',
      '   ',
      '\n\n\n',
      'Just a paragraph.\nAnother line.',
    ])('yields no rules from %j', (markdown) => {
      expect(parseRulesMarkdown(markdown)).toEqual({
        rules: [],
        duplicates: [],
      });
    });

    it('skips a heading with no text', () => {
      expect(parseRulesMarkdown('#\n##   \n').rules).toEqual([]);
    });
  });

  describe('headings', () => {
    it('makes each top-level heading a rule with its section as description', () => {
      const markdown = [
        'Intro text before any heading is dropped.',
        '',
        '## Use Bun',
        '',
        'Never `npm install`.',
        '',
        '### Why',
        'Pinned versions.',
        '',
        '## Biome only',
        'No ESLint, no Prettier.',
        '',
      ].join('\n');

      expect(parseRulesMarkdown(markdown)).toEqual({
        rules: [
          {
            title: 'Use Bun',
            description: 'Never `npm install`.\n\n### Why\nPinned versions.',
          },
          { title: 'Biome only', description: 'No ESLint, no Prettier.' },
        ],
        duplicates: [],
      });
    });

    it('treats a single top heading over deeper ones as the document title', () => {
      const markdown = [
        '# Conventions',
        'About this file.',
        '## Strict TypeScript',
        'No `any`.',
        '## Tests next to code',
        '`*.spec.ts`.',
      ].join('\n');

      expect(parseRulesMarkdown(markdown).rules).toEqual([
        { title: 'Strict TypeScript', description: 'No `any`.' },
        { title: 'Tests next to code', description: '`*.spec.ts`.' },
      ]);
    });

    it('keeps several top headings as rules even with deeper ones', () => {
      const markdown = '# A\ntext a\n## A.1\n# B\ntext b';

      expect(parseRulesMarkdown(markdown).rules).toEqual([
        { title: 'A', description: 'text a\n## A.1' },
        { title: 'B', description: 'text b' },
      ]);
    });

    it('accepts a lone heading and a closing sequence', () => {
      expect(parseRulesMarkdown('## Rule one ##\nBody').rules).toEqual([
        { title: 'Rule one', description: 'Body' },
      ]);
    });

    it('reads headings over list items and gives an empty section an empty description', () => {
      expect(parseRulesMarkdown('- item\n## Rule\n').rules).toEqual([
        { title: 'Rule', description: '' },
      ]);
    });

    it('ignores headings inside fenced code', () => {
      const markdown = [
        '## Shell',
        '```sh',
        '# not a heading',
        '```',
        '~~~',
        '## nor this',
        '~~~',
      ].join('\n');

      expect(parseRulesMarkdown(markdown).rules).toEqual([
        {
          title: 'Shell',
          description: '```sh\n# not a heading\n```\n~~~\n## nor this\n~~~',
        },
      ]);
    });

    it('needs a space after the hashes and at most three spaces before', () => {
      expect(parseRulesMarkdown('#hashtag\n    # code\n').rules).toEqual([]);
    });

    it('normalizes CRLF line endings', () => {
      expect(parseRulesMarkdown('## A\r\nbody\r\n## B\r\n').rules).toEqual([
        { title: 'A', description: 'body' },
        { title: 'B', description: '' },
      ]);
    });
  });

  describe('list items', () => {
    it('makes each top-level item a rule, its first line the title', () => {
      const markdown = [
        'Our rules:',
        '',
        '- Use Bun',
        '  never npm',
        '  - nested detail',
        '* Biome only',
        'lazy continuation',
        '',
        '1. Strict TypeScript',
        '2) Tests next to code',
        '',
        'A closing paragraph is not part of an item.',
      ].join('\n');

      expect(parseRulesMarkdown(markdown).rules).toEqual([
        {
          title: 'Use Bun',
          description: 'Use Bun\nnever npm\n- nested detail',
        },
        {
          title: 'Biome only',
          description: 'Biome only\nlazy continuation',
        },
        { title: 'Strict TypeScript', description: 'Strict TypeScript' },
        { title: 'Tests next to code', description: 'Tests next to code' },
      ]);
    });

    it('keeps indented paragraphs after a blank line in the item', () => {
      expect(
        parseRulesMarkdown('- One\n\n  more about one\n- Two').rules,
      ).toEqual([
        { title: 'One', description: 'One\n\nmore about one' },
        { title: 'Two', description: 'Two' },
      ]);
    });

    it('takes the least indented items as top level', () => {
      expect(parseRulesMarkdown('  - A\n    - a.1\n  - B').rules).toEqual([
        { title: 'A', description: 'A\n- a.1' },
        { title: 'B', description: 'B' },
      ]);
    });

    it('ignores list markers inside fenced code', () => {
      expect(parseRulesMarkdown('```\n- not a rule\n```').rules).toEqual([]);
    });
  });

  describe('duplicates', () => {
    it('keeps the first of a repeated heading title and reports the rest', () => {
      const markdown = '## Use Bun\nfirst\n## use   BUN\nsecond\n## Other\n';

      expect(parseRulesMarkdown(markdown)).toEqual({
        rules: [
          { title: 'Use Bun', description: 'first' },
          { title: 'Other', description: '' },
        ],
        duplicates: ['use BUN'],
      });
    });

    it('reports repeated list items', () => {
      expect(parseRulesMarkdown('- A\n- B\n- a\n- A')).toEqual({
        rules: [
          { title: 'A', description: 'A' },
          { title: 'B', description: 'B' },
        ],
        duplicates: ['a', 'A'],
      });
    });
  });

  describe('limits', () => {
    it('clips a long title and a long description', () => {
      const title = 'T'.repeat(PROJECT_RULE_TITLE_MAX + 50);
      const body = 'b'.repeat(PROJECT_RULE_DESCRIPTION_MAX + 50);
      const [rule] = parseRulesMarkdown(`## ${title}\n${body}`).rules;

      expect(rule.title).toHaveLength(PROJECT_RULE_TITLE_MAX);
      expect(rule.title.endsWith('…')).toBe(true);
      expect(rule.description).toHaveLength(PROJECT_RULE_DESCRIPTION_MAX);
      expect(rule.description.endsWith('…')).toBe(true);
    });
  });
});

describe('ruleTitleKey', () => {
  it('ignores case and surrounding or repeated whitespace', () => {
    expect(ruleTitleKey('  Use\tBun  now ')).toBe('use bun now');
    expect(ruleTitleKey('A')).toBe(ruleTitleKey('a'));
  });
});
