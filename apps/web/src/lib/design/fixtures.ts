import type {
  DesignCommentView,
  DesignRevisionView,
  TaskDesignView,
} from '@nautelle/shared';
import { BUILTIN_DESIGN_TEMPLATES, DEFAULT_VIEWPORTS } from '@nautelle/shared';

/** Design fixtures for the tests: one task, two variants, under review. */

/** #441: a revision's frames, named in order. */
export const framesOf = (id: string, names: readonly string[]) =>
  names.map((name, position) => ({
    position,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    htmlUrl: `/api/design-revisions/${id}/frames/${position}/html`,
    kind: 'legacy' as const,
    templateFrameKey: null,
  }));

export const revision = (
  over: Partial<DesignRevisionView> = {},
): DesignRevisionView => {
  const id = over.id ?? 'rev-1-1';
  return {
    id,
    variant: 1,
    revision: 1,
    title: 'Two-column settings',
    rationale: 'Keeps the form beside its preview.',
    turnId: 'turn-d1',
    archived: false,
    htmlUrl: `/api/design-revisions/${id}/html`,
    frames: [
      {
        position: 0,
        name: 'Mockup',
        slug: 'mockup',
        htmlUrl: `/api/design-revisions/${id}/frames/0/html`,
        kind: 'legacy',
        templateFrameKey: null,
      },
    ],
    templateKey: null,
    conformance: null,
    createdAt: '2026-10-14T10:00:00.000Z',
    ...over,
  };
};

export const comment = (
  over: Partial<DesignCommentView> = {},
): DesignCommentView => ({
  id: 'c1',
  revisionId: 'rev-1-1',
  frame: 0,
  kind: 'general',
  viewport: null,
  theme: null,
  x: null,
  y: null,
  selector: null,
  body: 'Tighter spacing.',
  author: { id: 'u1', name: 'Ada' },
  addressedInRevisionId: null,
  createdAt: '2026-10-14T10:05:00.000Z',
  ...over,
});

export const design = (over: Partial<TaskDesignView> = {}): TaskDesignView => ({
  id: 'design-1',
  owner: { kind: 'task', planId: 'plan-1', taskKey: 't1' },
  planId: 'plan-1',
  taskKey: 't1',
  needed: true,
  suggested: true,
  suggestionWhy: 'A new screen with real layout choices.',
  variantCount: 2,
  status: 'reviewing',
  approvedRevisionId: null,
  skills: [],
  skillsEdited: false,
  defaultSkills: [],
  profileId: 'profile-1',
  approvedBy: null,
  approvedAt: null,
  template: BUILTIN_DESIGN_TEMPLATES[0],
  revisions: [
    revision(),
    revision({ id: 'rev-1-2', revision: 2 }),
    revision({ id: 'rev-2-1', variant: 2, title: 'Tabs' }),
  ],
  comments: [],
  warnings: [],
  viewports: [...DEFAULT_VIEWPORTS],
  activeTurnId: null,
  busySince: null,
  progress: null,
  lastFailure: null,
  createdAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T10:05:00.000Z',
  ...over,
});
