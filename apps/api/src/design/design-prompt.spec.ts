import {
  BUILTIN_DESIGN_TEMPLATES,
  DEFAULT_VIEWPORTS,
  type DesignTemplate,
  designBytes,
} from '@nautelle/shared';
import { PLAN_TURN_PROMPT_MAX_BYTES } from '@nautelle/shared/protocol';
import { assemblePrompt, type PromptInput } from '../planner/plan-prompt';
import {
  cardDesignPrompt,
  type DesignPromptContext,
  designSections,
  frameSummary,
} from './design-prompt';
import { profilePreviewHtml } from './mockup-response';

const [page, , flow] = BUILTIN_DESIGN_TEMPLATES as DesignTemplate[];

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
  template: page,
  devices: DEFAULT_VIEWPORTS,
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
    expect(text).not.toContain('Use one frame unless');
    expect(text).toContain('one `agentdock-design` block per frame');
    expect(text).toContain('Its frames, in order: "Board page", "Card tile".');
    expect(text).toContain('"frame": "Card tile"');
    const generate = designSections(
      context({ mode: 'generate', previous: null, comments: [] }),
    ).join('\n\n');
    expect(generate).not.toContain('Its frames, in order');
  });

  // #833 (ADR-0082): the template's frames, numbered, in order.
  it('lists the frames to draw from the template, with kind, need and instruction', () => {
    const text = designSections(
      context({ mode: 'generate', previous: null }),
    ).join('\n\n');
    expect(text).toContain('# Frames to draw');
    expect(text).toContain('Template: "Page" (`page`)');
    expect(text).toContain(
      '1. Screen — kind `screen`, required. The finished page',
    );
    expect(text).toContain('2. Breakdown — kind `breakdown`, required.');
    expect(text).toContain('3. States — kind `states`, optional.');
    // D4: service frames are drawn in the project's kit.
    expect(text).toContain(
      'Service frames (Breakdown) use the same kit and custom properties as the screen',
    );
    expect(text).toContain('as `{ "name", "kind" }`');
  });

  it('leaves a disabled frame out, and names a custom frame exactly', () => {
    const own: DesignTemplate = {
      key: 'landing',
      name: 'Landing',
      frames: [
        page.frames[0],
        { ...page.frames[2], enabled: false },
        {
          key: 'hero',
          kind: 'custom',
          name: 'Hero copy',
          instruction: 'The hero headline variants.',
          required: true,
          enabled: true,
        },
      ],
    };
    const text = designSections(context({ template: own })).join('\n\n');
    expect(text).not.toContain('States — kind');
    expect(text).toContain(
      '2. Hero copy — kind `custom`, named exactly "Hero copy", required. The hero headline variants.',
    );
  });

  it('gives a flow its step limit', () => {
    const text = designSections(context({ template: flow })).join('\n\n');
    expect(text).toContain('one frame per step, 1–6 steps');
    expect(text).toContain(
      'If the flow needs more than 6 steps, draw the first 6.',
    );
  });

  it('names what a repair turn must fix (D7)', () => {
    const text = designSections(
      context({
        repair: {
          ok: false,
          missing: ['breakdown'],
          extra: ['Notes'],
          misplaced: [],
        },
      }),
    ).join('\n\n');
    expect(text).toContain('## Repair');
    expect(text).toContain('Revision 1 does not follow the template.');
    expect(text).toContain('Missing: "breakdown".');
    expect(text).toContain('Extra, not in the template: "Notes".');
    expect(designSections(context()).join('\n\n')).not.toContain('## Repair');
  });

  it('never drops the frames to draw to fit the cap', () => {
    const ctx = context();
    const prompt = cardDesignPrompt({
      instructions: 'INSTRUCTIONS',
      card: { number: 12, title: 'Tiles', body: 'Make tiles.' },
      taskKey: 'card-12',
      design: {
        ...ctx,
        profile: ctx.profile
          ? { ...ctx.profile, kit: 'k'.repeat(200 * 1024) }
          : null,
      },
    });
    expect(prompt).toContain('# Frames to draw');
    expect(prompt).toContain('2. Breakdown — kind `breakdown`, required.');
    expect(prompt).toContain('# Devices');
  });

  // #863 (ADR-0085): one responsive page per frame, for every chosen device.
  it('lists every chosen device with its size and asks for one responsive page per frame', () => {
    const text = designSections(
      context({
        mode: 'generate',
        previous: null,
        devices: [
          { name: 'Wide', width: 1920, height: 1080 },
          { name: 'Kiosk', width: 1080, height: 1920, theme: 'dark' },
        ],
      }),
    ).join('\n\n');
    expect(text).toContain('# Devices');
    expect(text).toContain(
      'one responsive page that works at each of these widths',
    );
    expect(text).toContain(
      'Do not draw a separate frame or a separate page per device',
    );
    expect(text).toContain('- Wide: 1920 × 1080 px');
    expect(text).toContain('- Kiosk: 1080 × 1920 px, dark theme');
    expect(text).not.toContain('- Desktop:');
  });

  it('lists the built-in devices when the design has the defaults', () => {
    const text = designSections(context()).join('\n\n');
    expect(text).toContain('- Desktop: 1440 × 900 px');
    expect(text).toContain('- Tablet: 834 × 1194 px');
    expect(text).toContain('- Phone: 390 × 844 px');
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

  describe('the profile memory (#752 A6)', () => {
    const screen = (i: number, summary = `Summary ${i}.`) => ({
      designId: `d${i}`,
      revisionId: `r${i}`,
      name: `Screen ${i}`,
      summary,
      snippetsUsed: i === 0 ? ['button'] : [],
      approvedAt: '2026-10-21T10:00:00.000Z',
    });
    const rule = {
      text: 'Primary actions sit bottom-right.',
      commentIds: [],
      designId: 'd0',
    };
    const withMemory = (
      screens: ReturnType<typeof screen>[],
      snippets = context().profile?.snippets ?? [],
    ): DesignPromptContext => {
      const ctx = context();
      if (!ctx.profile) throw new Error('no profile');
      return {
        ...ctx,
        profile: {
          ...ctx.profile,
          snippets,
          memory: { screens, styleRules: [rule] },
        },
      };
    };

    it('adds the approved screens and the style rules after the snippets', () => {
      const text = designSections(withMemory([screen(0), screen(1)])).join(
        '\n\n',
      );
      expect(text.indexOf('### Component snippets')).toBeLessThan(
        text.indexOf('### Approved screens'),
      );
      expect(text.indexOf('### Approved screens')).toBeLessThan(
        text.indexOf('### Style rules'),
      );
      expect(text).toContain('**Screen 0** (snippets: `button`)');
      expect(text).toContain('- Primary actions sit bottom-right.');
    });

    it('has neither section with the setting off', () => {
      const text = designSections(context()).join('\n\n');
      expect(text).not.toContain('### Approved screens');
      expect(text).not.toContain('### Style rules');
    });

    it('fitting drops the library oldest first, before any snippet, and never a style rule', () => {
      // 30 screens of ~1.4 KB (~42 KB), and as many 15 KiB snippets as leave
      // about 20 KB of room: over the cap together, under it without screens.
      const screens = Array.from({ length: 30 }, (_, i) =>
        screen(i, `S${i} `.padEnd(1400, 'z')),
      );
      const big = '<div>'.padEnd(15 * 1024, 'x');
      const bare = designBytes(
        assemblePrompt({ ...base, design: withMemory([], []) }),
      );
      const count = Math.floor(
        (PLAN_TURN_PROMPT_MAX_BYTES - 20 * 1024 - bare) / (15 * 1024 + 20),
      );
      const snippets = Array.from({ length: count }, (_, i) => ({
        name: `s${i}`,
        html: big,
      }));
      const design = withMemory(screens, snippets);
      expect(
        designBytes(
          assemblePrompt({ ...base, design: withMemory([], snippets) }),
        ),
      ).toBeLessThan(PLAN_TURN_PROMPT_MAX_BYTES);
      for (const prompt of [
        assemblePrompt({ ...base, design }),
        cardDesignPrompt({
          instructions: 'INSTRUCTIONS',
          card: { number: 12, title: 'Tiles', body: 'Make tiles.' },
          taskKey: 'card-12',
          design,
        }),
      ]) {
        expect(designBytes(prompt)).toBeLessThanOrEqual(
          PLAN_TURN_PROMPT_MAX_BYTES,
        );
        // Newest kept, oldest gone, and the note says so.
        expect(prompt).toContain('**Screen 0**');
        expect(prompt).not.toContain('**Screen 29**');
        expect(prompt).toContain('older approved screens were left out');
        expect(prompt).toContain('- Primary actions sit bottom-right.');
        // Every snippet is still there: the library went first.
        expect(prompt).not.toContain('more snippet');
        expect(prompt).toContain(`s${count - 1}:`);
      }
    });

    it('drops snippets only once the whole library is gone', () => {
      const big = '<div>'.padEnd(15 * 1024, 'x');
      const snippets = Array.from({ length: 40 }, (_, i) => ({
        name: `s${i}`,
        html: big,
      }));
      const prompt = assemblePrompt({
        ...base,
        design: withMemory([screen(0), screen(1)], snippets),
      });
      expect(prompt).toContain('2 older approved screens were left out');
      expect(prompt).toContain(
        'were left out to keep the prompt under its size limit: ',
      );
      expect(prompt).toContain('- Primary actions sit bottom-right.');
    });
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
