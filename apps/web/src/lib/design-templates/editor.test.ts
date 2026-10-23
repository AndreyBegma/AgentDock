import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_DESIGN_TEMPLATES,
  type DesignTemplate,
  type DesignTemplateView,
} from '@nautelle/shared';
import {
  addCustomFrame,
  blankDraft,
  draftOf,
  draftProblems,
  isBuiltinFrame,
  moveFrame,
  patchFrame,
  removeFrame,
  requestOf,
  templateKeyOf,
} from './editor';
import { designTemplatesApi } from './href';

const view = (key: string): DesignTemplateView => ({
  ...(BUILTIN_DESIGN_TEMPLATES.find((t) => t.key === key) as DesignTemplate),
  builtin: true,
  overridden: false,
  updatedBy: null,
  updatedAt: null,
});

describe('designTemplatesApi', () => {
  it('builds the list and the per-key routes', () => {
    expect(designTemplatesApi('p 1')).toBe('/projects/p%201/design/templates');
    expect(designTemplatesApi('p1', 'page')).toBe(
      '/projects/p1/design/templates/page',
    );
  });
});

describe('template drafts', () => {
  it('a built-in as served is a valid draft', () => {
    for (const t of BUILTIN_DESIGN_TEMPLATES) {
      expect(draftProblems(draftOf(view(t.key)))).toEqual([]);
    }
  });

  it('moves a frame and stops at the ends', () => {
    const { frames } = draftOf(view('page'));
    expect(moveFrame(frames, 0, 1).map((f) => f.key)).toEqual([
      'breakdown',
      'screen',
      'states',
    ]);
    expect(moveFrame(frames, 0, -1).map((f) => f.key)).toEqual(
      frames.map((f) => f.key),
    );
  });

  it('adds a custom frame with a fresh key, and only that kind is removable', () => {
    let frames = draftOf(view('page')).frames;
    frames = addCustomFrame(addCustomFrame(frames));
    expect(frames.slice(-2).map((f) => f.key)).toEqual([
      'custom-1',
      'custom-2',
    ]);
    expect(isBuiltinFrame('page', 'screen')).toBe(true);
    expect(isBuiltinFrame('page', 'custom-1')).toBe(false);
    expect(removeFrame('page', frames, 'screen')).toHaveLength(frames.length);
    expect(removeFrame('page', frames, 'custom-1')).toHaveLength(
      frames.length - 1,
    );
  });

  it('says what is wrong with a blank custom frame, and passes once filled', () => {
    const draft = draftOf(view('page'));
    const added = { ...draft, frames: addCustomFrame(draft.frames) };
    expect(draftProblems(added).length).toBeGreaterThan(0);
    const filled = {
      ...added,
      frames: patchFrame(added.frames, 'custom-1', {
        name: 'Notes',
        instruction: 'Release notes.',
      }),
    };
    expect(draftProblems(filled)).toEqual([]);
    expect(requestOf(filled).frames.at(-1)?.name).toBe('Notes');
  });

  it('refuses disabling a required frame and renaming a built-in one', () => {
    const draft = draftOf(view('page'));
    const off = {
      ...draft,
      frames: patchFrame(draft.frames, 'screen', { enabled: false }),
    };
    expect(draftProblems(off).join()).toContain('required');
    const renamed = {
      ...draft,
      frames: patchFrame(draft.frames, 'screen', { name: 'Hero' }),
    };
    expect(draftProblems(renamed)).toEqual([
      'the name of frame screen is fixed',
    ]);
  });

  it('derives a key from the name, and starts a blank template with its screen', () => {
    expect(templateKeyOf('Landing page!')).toBe('landing-page');
    expect(templateKeyOf('3 steps')).toBe('steps');
    expect(templateKeyOf('???')).toBe('');
    const blank = blankDraft(' Email ');
    expect(blank).toMatchObject({ key: 'email', name: 'Email' });
    expect(draftProblems(blank).join()).toContain('instruction');
  });
});
