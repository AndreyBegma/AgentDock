import { designBytes } from '@agentdock/shared';
import { PLAN_TURN_PROMPT_MAX_BYTES } from '@agentdock/shared/protocol';
import { assemblePrompt, type PromptInput } from '../planner/plan-prompt';
import {
  cardDesignPrompt,
  type DesignPromptContext,
  designSections,
  frameSummary,
} from './design-prompt';
import { profilePreviewHtml } from './mockup-response';

const context = (
  over: Partial<DesignPromptContext> = {},
): DesignPromptContext => ({
  variant: 2,
  variantCount: 3,
  mode: 'revise',
  previous: {
    revision: 1,
    title: 'Two columns',
    rationale: 'Dense.',
    frames: [
      {
        name: 'Board page',
        html: '<!doctype html><html><head><title>Board</title></head><body><h1>Sprint board</h1><h2>To do</h2><h2>Done</h2><p>BOARD-BODY</p></body></html>',
      },
      {
        name: 'Card tile',
        html: '<!doctype html><html><body><h1>Tile</h1><p>TILE-BODY</p></body></html>',
      },
    ],
  },
  profile: {
    version: 4,
    hasUi: true,
    summary: 'React 19 and glass-ui.',
    kit: ':root{--accent:#000}',
    snippets: [{ name: 'button', html: '<button>Go</button>' }],
  },
  skills: ['frontend-design'],
  comments: [
    {
      id: 'c1',
      kind: 'pin',
      variant: 2,
      revision: 1,
      frame: 'Card tile',
      viewport: 'Mobile',
      theme: 'dark',
      x: 10,
      y: 20,
      selector: 'main > button',
      body: 'Bigger.',
    },
  ],
  ...over,
});

const base: PromptInput = {
  instructions: 'INSTRUCTIONS',
  action: 'design',
  brief: 'Build an exporter',
  plan: { title: 'Exporter', mode: 'batch', version: 1 },
  tasks: [],
  taskKey: 't1',
  round: [],
  input: {},
  contractVersion: 2,
};

describe('design turn prompt (D8)', () => {
  it('carries the profile, the kit, the skills, the variant and every open comment', () => {
    const text = designSections(context()).join('\n\n');
    expect(text).toContain('Variant: 2 (of 3).');
    expect(text).toContain('React 19 and glass-ui.');
    expect(text).toContain(':root{--accent:#000}');
    expect(text).toContain('`frontend-design`');
    expect(text).toContain('"selector": "main > button"');
    expect(text).toContain('"id": "c1"');
  });

  it('asks for named frames, and passes each comment with its frame (#441)', () => {
    const text = designSections(context()).join('\n\n');
    expect(text).toContain(
      'Use one frame unless the task touches several pages',
    );
    expect(text).toContain('one `agentdock-design` block per frame');
    expect(text).toContain('Its frames, in order: "Board page", "Card tile".');
    expect(text).toContain('"frame": "Card tile"');
    const generate = designSections(
      context({ mode: 'generate', previous: null, comments: [] }),
    ).join('\n\n');
    expect(generate).not.toContain('Its frames, in order');
  });

  // #628: a revise sends the frames the comments point at, and a summary of the rest.
  it('sends the commented frame in full and only a summary of the others', () => {
    const text = designSections(context()).join('\n\n');
    expect(text).toContain('#### Frame "Card tile"');
    expect(text).toContain('TILE-BODY');
    expect(text).not.toContain('BOARD-BODY');
    expect(text).toContain(
      '- "Board page" — 1 KiB; titled "Board"; headings: "Sprint board", "To do", "Done"',
    );
    expect(text).toContain('`"kept"` naming the kept ones');
  });

  it('sends every frame in full when no comment of the variant points at one', () => {
    const elsewhere = context().comments.map((c) => ({ ...c, variant: 1 }));
    const text = designSections(context({ comments: elsewhere })).join('\n\n');
    expect(text).toContain('BOARD-BODY');
    expect(text).toContain('TILE-BODY');
  });

  it('summarizes a frame by its size, title and first headings', () => {
    expect(
      frameSummary({
        name: 'Empty',
        html: `<main>${'x'.repeat(3 * 1024)}</main>`,
      }),
    ).toBe('- "Empty" — 3 KiB');
  });

  it('keeps what is the same from turn to turn ahead of the turn itself', () => {
    const prompt = cardDesignPrompt({
      instructions: 'INSTRUCTIONS',
      card: { number: 12, title: 'Tiles', body: 'Make tiles.' },
      taskKey: 'card-12',
      design: context(),
    });
    const at = (needle: string) => prompt.indexOf(needle);
    expect(at('INSTRUCTIONS')).toBe(0);
    expect(at('## The card')).toBeLessThan(at('## UI profile'));
    expect(at('## Design skills')).toBeLessThan(at('# This turn'));
    expect(at('# This turn')).toBeLessThan(at('## Design\n'));
    expect(at('## Design\n')).toBeLessThan(at('## Open comments'));
  });

  it('summarizes the previous frames when nothing else brings the prompt under its cap', () => {
    const huge = `<main>${'y'.repeat(150 * 1024)}</main>`;
    const ctx = context();
    const prompt = cardDesignPrompt({
      instructions: 'INSTRUCTIONS',
      card: { number: 12, title: 'Tiles', body: 'Make tiles.' },
      taskKey: 'card-12',
      design: {
        ...ctx,
        profile: ctx.profile
          ? { ...ctx.profile, kit: 'k'.repeat(120 * 1024) }
          : null,
        previous: ctx.previous
          ? {
              ...ctx.previous,
              frames: ctx.previous.frames.map((f) => ({ ...f, html: huge })),
            }
          : null,
      },
    });
    expect(designBytes(prompt)).toBeLessThanOrEqual(PLAN_TURN_PROMPT_MAX_BYTES);
    expect(prompt).toContain(
      'Its frames, summarized (too large to include here):',
    );
  });

  it('trims snippets from the end to keep the prompt under its cap, and says so', () => {
    const big = '<div>'.padEnd(15 * 1024, 'x');
    const snippets = Array.from({ length: 40 }, (_, i) => ({
      name: `s${i}`,
      html: big,
    }));
    const ctx = context();
    const prompt = assemblePrompt({
      ...base,
      design: {
        ...ctx,
        profile: ctx.profile ? { ...ctx.profile, snippets } : null,
      },
    });
    expect(designBytes(prompt)).toBeLessThanOrEqual(PLAN_TURN_PROMPT_MAX_BYTES);
    expect(prompt).toContain(
      'were left out to keep the prompt under its size limit',
    );
    expect(prompt).toContain('`s39`');
  });

  it('appends the design action to a v1 plan’s contract', () => {
    const v1 = assemblePrompt({
      ...base,
      contractVersion: 1,
      design: context(),
    });
    expect(v1).toContain('# Output contract (v1)');
    expect(v1).toContain('## The design action');
    const write = assemblePrompt({
      ...base,
      action: 'write',
      contractVersion: 1,
    });
    expect(write).not.toContain('## The design action');
  });
});

describe('profilePreviewHtml', () => {
  it('composes the kit and every snippet, and the kit cannot close its style', () => {
    const html = profilePreviewHtml({
      version: 2,
      kit: 'a{color:red}</style><script>alert(1)</script>',
      snippets: [{ name: '<b>card</b>', html: '<div class="card">Card</div>' }],
    });
    expect(html).toContain('<div class="card">Card</div>');
    expect(html).toContain('&lt;b&gt;card&lt;/b&gt;');
    expect(html).not.toContain('</style><script>');
  });
});
