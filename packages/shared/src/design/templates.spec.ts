import { describe, expect, it } from 'bun:test';
import { builtinOverrideProblems } from './template-api';
import {
  BUILTIN_DESIGN_TEMPLATES,
  builtinDesignTemplate,
  carryRequiredFrames,
  checkConformance,
  conformanceOf,
  type DesignFrameKind,
  type DesignTemplate,
  designTemplateSchema,
  resolveDesignTemplate,
} from './templates';

const page = builtinDesignTemplate('page') as DesignTemplate;
const component = builtinDesignTemplate('component') as DesignTemplate;
const flow = builtinDesignTemplate('flow') as DesignTemplate;

const f = (kind: DesignFrameKind, name: string = kind) => ({ name, kind });
const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => f('flow_step', `Step ${i + 1}`));

describe('BUILTIN_DESIGN_TEMPLATES', () => {
  it('are page, component and flow, each valid', () => {
    expect(BUILTIN_DESIGN_TEMPLATES.map((t) => t.key)).toEqual([
      'page',
      'component',
      'flow',
    ]);
    for (const t of BUILTIN_DESIGN_TEMPLATES) {
      expect(designTemplateSchema.safeParse(t).success).toBe(true);
    }
  });

  it('key each built-in frame by its kind', () => {
    for (const t of BUILTIN_DESIGN_TEMPLATES) {
      for (const frame of t.frames) expect(frame.key).toBe(frame.kind);
    }
  });

  // #863 (ADR-0084): every frame is one responsive page; no device frame.
  it('draw no mobile frame in page and flow, and still parse the mobile kind', () => {
    expect(page.frames.map((fr) => fr.key)).toEqual([
      'screen',
      'breakdown',
      'states',
    ]);
    expect(flow.frames.map((fr) => fr.key)).toEqual([
      'flow_map',
      'flow_step',
      'breakdown',
    ]);
    for (const t of [page, flow]) {
      for (const frame of t.frames) {
        expect(frame.instruction.toLowerCase()).not.toContain('mobile');
        expect(frame.instruction.toLowerCase()).not.toContain('narrow');
      }
    }
    const old = {
      key: 'x',
      name: 'X',
      frames: [{ ...page.frames[2], key: 'mobile', kind: 'mobile' }],
    };
    expect(designTemplateSchema.safeParse(old).success).toBe(true);
  });
});

describe('designTemplateSchema', () => {
  const custom = (over: object = {}) => ({
    key: 'notes',
    kind: 'custom',
    name: 'Notes',
    instruction: 'What changed.',
    required: false,
    enabled: true,
    ...over,
  });

  it('accepts a project template with custom frames', () => {
    const landing = {
      key: 'landing',
      name: 'Landing',
      frames: [page.frames[0], custom()],
    };
    expect(designTemplateSchema.safeParse(landing).success).toBe(true);
  });

  it('refuses a twice-used key, kind or name', () => {
    const twice = (frames: object[]) =>
      designTemplateSchema.safeParse({ key: 'x', name: 'X', frames }).success;
    expect(twice([custom(), custom({ name: 'Other' })])).toBe(false);
    expect(
      twice([page.frames[0], { ...page.frames[0], key: 's2', name: 'B' }]),
    ).toBe(false);
    expect(twice([custom(), custom({ key: 'other' })])).toBe(false);
  });

  it('refuses a legacy frame, a repeat off flow_step and a disabled required frame', () => {
    const one = (frame: object) =>
      designTemplateSchema.safeParse({ key: 'x', name: 'X', frames: [frame] })
        .success;
    expect(one(custom({ kind: 'legacy' }))).toBe(false);
    expect(one(custom({ repeat: { min: 1, max: 3 } }))).toBe(false);
    expect(one(custom({ required: true, enabled: false }))).toBe(false);
    expect(one(custom({ required: false, enabled: false }))).toBe(true);
  });
});

describe('resolveDesignTemplate', () => {
  it('is the built-in without an override, and the override over it', () => {
    expect(resolveDesignTemplate(page)).toBe(page);
    const off = {
      ...page,
      frames: page.frames.map((fr) =>
        fr.key === 'states' ? { ...fr, enabled: false } : fr,
      ),
    };
    expect(
      resolveDesignTemplate(page, off)?.frames.find((fr) => fr.key === 'states')
        ?.enabled,
    ).toBe(false);
  });

  it('puts back a required built-in frame the override lacks', () => {
    const lacking = { ...page, frames: [page.frames[0], page.frames[2]] };
    expect(
      resolveDesignTemplate(page, lacking)?.frames.map((fr) => fr.key),
    ).toEqual(['screen', 'breakdown', 'states']);
  });

  // #863 (ADR-0084): an override saved before page and flow lost `mobile`.
  it('reads an older override without the mobile frame and with current names', () => {
    const notes = {
      key: 'notes',
      kind: 'custom' as const,
      name: 'Notes',
      instruction: 'What changed.',
      required: false,
      enabled: true,
    };
    const oldFlow = {
      ...flow,
      frames: [
        ...flow.frames,
        {
          key: 'mobile',
          kind: 'mobile' as const,
          name: 'Mobile',
          instruction: 'The steps at the narrow width.',
          required: false,
          enabled: true,
        },
        notes,
      ],
    };
    expect(
      resolveDesignTemplate(flow, oldFlow)?.frames.map((fr) => fr.key),
    ).toEqual(['flow_map', 'flow_step', 'breakdown', 'notes']);

    const oldPage = {
      ...page,
      frames: page.frames.map((fr) =>
        fr.key === 'states'
          ? {
              ...fr,
              name: 'States and mobile',
              instruction:
                'The empty, loading and error states, and the page at the narrow width.',
            }
          : fr.key === 'screen'
            ? { ...fr, instruction: 'Our own words.' }
            : fr,
      ),
    };
    const resolved = resolveDesignTemplate(page, oldPage);
    const states = resolved?.frames.find((fr) => fr.key === 'states');
    expect(states?.name).toBe('States');
    expect(states?.instruction).toBe('The empty, loading and error states.');
    expect(
      resolved?.frames.find((fr) => fr.key === 'screen')?.instruction,
    ).toBe('Our own words.');
    expect(builtinOverrideProblems(page, resolved as DesignTemplate)).toEqual(
      [],
    );
  });

  it("is a project's own template alone", () => {
    const own = { key: 'landing', name: 'Landing', frames: [page.frames[0]] };
    expect(resolveDesignTemplate(undefined, own)).toBe(own);
    expect(resolveDesignTemplate(undefined, null)).toBeNull();
  });
});

describe('checkConformance', () => {
  it('passes page with screen and breakdown, and keys each frame', () => {
    const result = checkConformance(page, [f('screen'), f('breakdown')]);
    expect(conformanceOf(result)).toEqual({
      ok: true,
      missing: [],
      extra: [],
      misplaced: [],
    });
    expect(result.templateFrameKeys).toEqual(['screen', 'breakdown']);
  });

  it('names a missing required frame', () => {
    const result = checkConformance(page, [f('screen')]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['breakdown']);
  });

  it('reads a legacy frame as extra', () => {
    const result = checkConformance(page, [f('legacy', 'Mockup')]);
    expect(result.extra).toEqual(['Mockup']);
    expect(result.missing).toEqual(['screen', 'breakdown']);
  });

  it('names only the frames off the ordered run as misplaced', () => {
    const result = checkConformance(component, [
      f('anatomy'),
      f('in_context'),
      f('state_grid'),
    ]);
    expect(result.ok).toBe(false);
    expect(result.misplaced).toHaveLength(1);
    expect(result.missing).toEqual([]);
  });

  it('reads a disabled optional frame and a second of a kind as extra', () => {
    const noStates = {
      ...page,
      frames: page.frames.map((fr) =>
        fr.key === 'states' ? { ...fr, enabled: false } : fr,
      ),
    };
    expect(
      checkConformance(noStates, [
        f('screen'),
        f('breakdown'),
        f('states', 'S'),
      ]).extra,
    ).toEqual(['S']);
    expect(
      checkConformance(page, [
        f('screen'),
        f('screen', 'Again'),
        f('breakdown'),
      ]).extra,
    ).toEqual(['Again']);
  });

  it('accepts 1–6 flow steps and marks 7 too_many_steps', () => {
    for (const n of [1, 6]) {
      const result = checkConformance(flow, [
        f('flow_map'),
        ...steps(n),
        f('breakdown'),
      ]);
      expect(result.ok).toBe(true);
      expect(result.templateFrameKeys[n]).toBe(`flow_step-${n}`);
    }
    const seven = checkConformance(flow, [
      f('flow_map'),
      ...steps(7),
      f('breakdown'),
    ]);
    expect(seven.ok).toBe(false);
    expect(seven.reason).toBe('too_many_steps');
    expect(seven.missing).toEqual([]);
  });

  it('reads a mobile frame of an older revision as extra (#863)', () => {
    const result = checkConformance(flow, [
      f('flow_map'),
      ...steps(2),
      f('breakdown'),
      f('mobile', 'Mobile'),
    ]);
    expect(result.extra).toEqual(['Mobile']);
    expect(result.missing).toEqual([]);
  });

  it('matches a custom frame by its name', () => {
    const landing: DesignTemplate = {
      key: 'landing',
      name: 'Landing',
      frames: [
        page.frames[0],
        {
          key: 'hero',
          kind: 'custom',
          name: 'Hero copy',
          instruction: 'The hero copy.',
          required: true,
          enabled: true,
        },
      ],
    };
    const ok = checkConformance(landing, [
      f('screen'),
      f('custom', 'hero copy'),
    ]);
    expect(ok.ok).toBe(true);
    expect(ok.templateFrameKeys).toEqual(['screen', 'hero']);
    expect(
      checkConformance(landing, [f('screen'), f('custom', 'Other')]).missing,
    ).toEqual(['hero']);
  });
});

describe('carryRequiredFrames', () => {
  const html = (kind: DesignFrameKind, name: string = kind) => ({
    ...f(kind, name),
    html: `<p>${name}</p>`,
  });

  it('keeps the previous required frames a revise left out, in template order', () => {
    const previous = [html('in_context'), html('anatomy'), html('state_grid')];
    const answer = [html('anatomy', 'Anatomy v2')];
    const carried = carryRequiredFrames(component, answer, previous);
    expect(carried.map((fr) => fr.name)).toEqual([
      'in_context',
      'Anatomy v2',
      'state_grid',
    ]);
    expect(checkConformance(component, carried).ok).toBe(true);
  });

  it('never carries an optional frame, nor a frame the previous revision lacks', () => {
    const previous = [html('screen'), html('states')];
    expect(
      carryRequiredFrames(page, [html('screen', 'New')], previous).map(
        (fr) => fr.name,
      ),
    ).toEqual(['New']);
  });

  it('carries every previous step of a flow that drew none', () => {
    const previous = [
      html('flow_map'),
      ...steps(2).map((s) => ({ ...s, html: '' })),
      html('breakdown'),
    ];
    const carried = carryRequiredFrames(
      flow,
      [html('flow_map', 'Map v2')],
      previous,
    );
    expect(carried.map((fr) => fr.name)).toEqual([
      'Map v2',
      'Step 1',
      'Step 2',
      'breakdown',
    ]);
  });
});
