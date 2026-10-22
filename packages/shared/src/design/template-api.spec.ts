import { describe, expect, it } from 'bun:test';
import { builtinOverrideProblems } from './template-api';
import {
  builtinDesignTemplate,
  type DesignTemplate,
  type DesignTemplateFrame,
} from './templates';

const page = builtinDesignTemplate('page') as DesignTemplate;
const flow = builtinDesignTemplate('flow') as DesignTemplate;

const edit = (
  base: DesignTemplate,
  change: (frames: DesignTemplateFrame[]) => DesignTemplateFrame[],
): DesignTemplate => ({
  ...base,
  frames: change(base.frames.map((f) => ({ ...f }))),
});

const custom: DesignTemplateFrame = {
  key: 'notes',
  kind: 'custom',
  name: 'Notes',
  instruction: 'Release notes for the page.',
  required: false,
  enabled: true,
};

describe('builtinOverrideProblems', () => {
  it('accepts the built-in itself', () => {
    expect(builtinOverrideProblems(page, page)).toEqual([]);
  });

  it('accepts disabling an optional frame, a new instruction, a custom frame and a new order', () => {
    const next = edit(page, (frames) => {
      const [screen, breakdown, states] = frames;
      return [
        { ...states, enabled: false },
        { ...breakdown, instruction: 'Own words.' },
        screen,
        custom,
      ];
    });
    expect(builtinOverrideProblems(page, next)).toEqual([]);
  });

  it('accepts a lower repeat.max of a flow step', () => {
    const next = edit(flow, (frames) =>
      frames.map((f) =>
        f.kind === 'flow_step' && f.repeat
          ? { ...f, repeat: { min: f.repeat.min, max: 3 } }
          : f,
      ),
    );
    expect(builtinOverrideProblems(flow, next)).toEqual([]);
  });

  it('refuses dropping a required frame', () => {
    const next = edit(page, (frames) =>
      frames.filter((f) => f.key !== 'screen'),
    );
    expect(builtinOverrideProblems(page, next)).toEqual([
      'the required frame screen cannot be removed',
    ]);
  });

  it('refuses changing a built-in frame’s kind, name, requirement or repeat.min', () => {
    const next = edit(flow, (frames) =>
      frames.map((f) =>
        f.key === 'flow_step'
          ? {
              ...f,
              name: 'Stage',
              required: false,
              repeat: { min: 2, max: 6 },
            }
          : f,
      ),
    );
    expect(builtinOverrideProblems(flow, next)).toEqual([
      'the name of frame flow_step is fixed',
      'frame flow_step cannot become optional',
      'repeat.min of frame flow_step is fixed',
    ]);
  });

  it('refuses a built-in kind that is not the template’s own, and a rename', () => {
    const next = {
      ...edit(page, (frames) => [
        ...frames,
        { ...custom, key: 'mobile', kind: 'mobile' as const },
      ]),
      name: 'Screen',
    };
    expect(builtinOverrideProblems(page, next)).toEqual([
      'the name of the built-in page template is fixed',
      'frame mobile is not a frame of page',
    ]);
  });
});
