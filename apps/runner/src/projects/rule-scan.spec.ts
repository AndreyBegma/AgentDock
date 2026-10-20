import { afterEach, describe, expect, it } from 'bun:test';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  projectScanRulesResultSchema,
  RULE_SCAN_FILE_MAX_BYTES,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { spyFs, workspace } from '../testing/projects';
import {
  configCandidates,
  guideCandidates,
  parseJsonc,
  scanProjectRules,
} from './rule-scan';

let ws: ReturnType<typeof workspace>;
afterEach(() => ws?.cleanup());

const scan = (path: string) =>
  projectScanRulesResultSchema.parse(scanProjectRules(path));

describe('guideCandidates', () => {
  it('makes a rule of each top-level list item, a bold lead its title', () => {
    const markdown = [
      '# Project',
      '',
      '## Conventions',
      '',
      '- **Bun** is the package manager; never `npm install`.',
      '- **Biome only:** single quotes, trailing commas.',
      '- Strict TypeScript everywhere; no `any`.',
      '  Nested continuation line.',
      '  - a nested item stays in the parent',
      '',
      'Paragraph text is not a rule.',
    ].join('\n');

    expect(guideCandidates(markdown, 'CLAUDE.md')).toEqual([
      {
        title: 'Bun is the package manager',
        description: '**Bun** is the package manager; never `npm install`.',
        source: 'CLAUDE.md',
      },
      {
        title: 'Biome only',
        description: 'single quotes, trailing commas.',
        source: 'CLAUDE.md',
      },
      {
        title: 'Strict TypeScript everywhere',
        description:
          'Strict TypeScript everywhere; no `any`.\nNested continuation line.\n- a nested item stays in the parent',
        source: 'CLAUDE.md',
      },
    ]);
  });

  it('leaves out sections about the repository, fenced code, task boxes and short items', () => {
    const markdown = [
      '## Structure',
      '- apps/api is the NestJS API',
      '## Commands',
      '- bun run test runs the tests',
      '## Rules',
      '```',
      '- not a rule inside a fence',
      '```',
      '- [ ] a task box is not a rule',
      '- Too short',
      '- Commit messages use the imperative mood.',
    ].join('\n');

    expect(guideCandidates(markdown, 'AGENTS.md').map((c) => c.title)).toEqual([
      'Commit messages use the imperative mood',
    ]);
  });

  it('cuts a long first clause into a short title, keeping the full text', () => {
    const long = `Every ${'very '.repeat(30)}long rule`;
    const [only] = guideCandidates(`- ${long}`, 'CLAUDE.md');
    expect(only?.title.length).toBeLessThanOrEqual(81);
    expect(only?.title.endsWith('…')).toBe(true);
    expect(only?.description).toBe(long);
  });
});

describe('configCandidates', () => {
  it('maps Biome formatter and linter options', () => {
    const biome = JSON.stringify({
      formatter: { indentStyle: 'space', indentWidth: 2 },
      javascript: {
        formatter: { quoteStyle: 'single', trailingCommas: 'all' },
      },
      linter: { enabled: true, rules: { recommended: true } },
    });
    expect(configCandidates(biome, 'biome.json').candidates).toEqual([
      {
        title: 'Format with Biome',
        description:
          'Biome formats the code: single quotes, 2-space indentation and trailing commas. Run the formatter before committing.',
        source: 'biome.json',
      },
      {
        title: 'Lint with Biome',
        description:
          'Biome is the linter, with its recommended rules. Fix every lint error before committing.',
        source: 'biome.json',
      },
    ]);
  });

  it('reads tsconfig with comments and trailing commas', () => {
    const tsconfig = `{
      // comment
      "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, /* x */ },
    }`;
    expect(configCandidates(tsconfig, 'tsconfig.json').candidates).toEqual([
      {
        title: 'Strict TypeScript',
        description:
          'TypeScript runs with strict on (tsconfig.json), and also noUncheckedIndexedAccess. Code must compile under it without suppressing errors.',
        source: 'tsconfig.json',
      },
    ]);
    expect(
      configCandidates('{"compilerOptions":{}}', 'tsconfig.json').candidates,
    ).toEqual([]);
  });

  it('reads the [*] section of .editorconfig', () => {
    const editorconfig = [
      'root = true',
      '[*]',
      'indent_style = space',
      'indent_size = 4',
      'end_of_line = lf',
      'insert_final_newline = true',
      '[*.md]',
      'trim_trailing_whitespace = true',
    ].join('\n');
    expect(configCandidates(editorconfig, '.editorconfig').candidates).toEqual([
      {
        title: 'Follow .editorconfig',
        description:
          'Every file uses 4-space indentation, LF line endings and a final newline, as .editorconfig sets.',
        source: '.editorconfig',
      },
    ]);
  });

  it('names ESLint and its bases; a YAML .eslintrc still counts', () => {
    expect(
      configCandidates(
        JSON.stringify({ extends: ['next', 'prettier'] }),
        '.eslintrc.json',
      ).candidates[0]?.description,
    ).toBe(
      'ESLint is the linter (.eslintrc.json); the config extends next and prettier. Fix every lint error before committing.',
    );
    expect(
      configCandidates('extends: next\n', '.eslintrc').candidates[0]?.title,
    ).toBe('Lint with ESLint');
  });

  it('warns about a config that is not JSON', () => {
    expect(configCandidates('{ nope', 'biome.json')).toEqual({
      candidates: [],
      warning: 'biome.json is not valid JSON; skipped.',
    });
  });
});

describe('parseJsonc', () => {
  it('keeps comment-like text inside strings', () => {
    expect(parseJsonc('{"url": "https://x//y", "a": "/* b */"}')).toEqual({
      url: 'https://x//y',
      a: '/* b */',
    });
  });
});

describe('project.scan_rules', () => {
  it('scans the guides, then the configs, deduplicated by title', () => {
    ws = workspace();
    ws.files({
      'x/CLAUDE.md': '- Use Bun for every script.\n',
      'x/AGENTS.md':
        '- use bun for every script\n- Keep functions small and pure.\n',
      'x/biome.json': JSON.stringify({ formatter: { indentStyle: 'tab' } }),
      'x/README.md': '- README is not read.\n',
    });

    const result = scan(join(ws.ws, 'x'));

    expect(result.candidates).toEqual([
      {
        title: 'Use Bun for every script',
        description: '',
        source: 'CLAUDE.md',
      },
      {
        title: 'Keep functions small and pure',
        description: '',
        source: 'AGENTS.md',
      },
      {
        title: 'Format with Biome',
        description:
          'Biome formats the code: tab indentation. Run the formatter before committing.',
        source: 'biome.json',
      },
    ]);
    expect(result.scanned).toEqual(['CLAUDE.md', 'AGENTS.md', 'biome.json']);
    expect(result.warnings).toEqual([]);
  });

  it('skips oversized and binary files, and links out of the project, unread', () => {
    ws = workspace();
    ws.files({
      'x/CLAUDE.md': `- ${'x'.repeat(RULE_SCAN_FILE_MAX_BYTES)}\n`,
      'x/CONTRIBUTING.md': '- Binary\u0000 content here.\n',
      'outside/AGENTS.md': '- A secret from outside the project.\n',
    });
    symlinkSync(join(ws.ws, 'outside/AGENTS.md'), join(ws.ws, 'x/AGENTS.md'));
    const { fs, accesses } = spyFs();

    const result = scanProjectRules(join(ws.ws, 'x'), { fs });

    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual([
      'CLAUDE.md is larger than 256 KB; skipped.',
      'AGENTS.md links outside the project; skipped.',
      'CONTRIBUTING.md is not a text file; skipped.',
    ]);
    const read = accesses
      .filter((a) => a.method === 'readFile')
      .map((a) => a.path);
    expect(read).toEqual([join(ws.ws, 'x/CONTRIBUTING.md')]);
  });

  it('follows a link that stays inside the project', () => {
    ws = workspace();
    ws.files({ 'x/AGENTS.md': '- Write tests next to the code.\n' });
    symlinkSync(join(ws.ws, 'x/AGENTS.md'), join(ws.ws, 'x/CLAUDE.md'));

    const result = scan(join(ws.ws, 'x'));

    expect(result.candidates.map((c) => c.source)).toEqual(['CLAUDE.md']);
    expect(result.warnings).toEqual([]);
  });

  it('answers path_not_found for a missing directory', () => {
    ws = workspace();
    expect(() => scanProjectRules(join(ws.ws, 'missing'))).toThrow(
      CommandFailure,
    );
  });
});
