import {
  buildCompressPrompt,
  parseCompressAnswer,
  renderedRules,
} from './rules-compress-input';

const rules = [
  {
    id: 'r1',
    title: 'Use Bun',
    description:
      'Always use Bun, never npm or yarn, in every package of the repository.',
  },
  {
    id: 'r2',
    title: 'Biome only',
    description:
      'Biome formats and lints; there is no ESLint and no Prettier anywhere.',
  },
];

describe('rules compression input (#751 B6)', () => {
  it('asks about every rule by id', () => {
    const prompt = buildCompressPrompt(rules);
    expect(prompt).toContain('"id":"r1"');
    expect(prompt).toContain('"id":"r2"');
    expect(prompt).toContain('every id exactly once');
  });

  it('takes one shorter description per rule and keeps the titles', () => {
    const parsed = parseCompressAnswer(
      '```json\n{"rules":[{"id":"r2","description":"Biome only; no ESLint/Prettier."},{"id":"r1","description":"Bun only."}]}\n```',
      rules,
    );
    expect(parsed).toEqual({
      ok: true,
      compressed: {
        rules: [
          { id: 'r1', title: 'Use Bun', description: 'Bun only.' },
          {
            id: 'r2',
            title: 'Biome only',
            description: 'Biome only; no ESLint/Prettier.',
          },
        ],
      },
    });
  });

  it('keeps the original of a description that grew or went empty', () => {
    const parsed = parseCompressAnswer(
      JSON.stringify({
        rules: [
          { id: 'r1', description: `${rules[0]?.description} And more words.` },
          { id: 'r2', description: '  ' },
        ],
      }),
      rules,
    );
    expect(
      parsed.ok && parsed.compressed.rules.map((r) => r.description),
    ).toEqual(rules.map((r) => r.description));
  });

  it('refuses an answer that drops, repeats or invents a rule', () => {
    const bad = [
      'not json',
      '{"rules":[{"id":"r1","description":"x"}]}',
      '{"rules":[{"id":"r1","description":"x"},{"id":"r1","description":"y"}]}',
      '{"rules":[{"id":"r1","description":"x"},{"id":"r3","description":"y"}]}',
      '{"items":[]}',
    ];
    for (const text of bad) {
      expect(parseCompressAnswer(text, rules).ok).toBe(false);
    }
  });

  it('renders the block the diff and sizes are about', () => {
    const text = renderedRules(rules);
    expect(text).toContain('## Project coding rules');
    expect(text).toContain('1. Use Bun');
  });
});
