import type {
  DesignCommentView,
  DesignRevisionView,
  TaskDesignView,
} from '@agentdock/shared';
import { DEFAULT_VIEWPORTS } from '@agentdock/shared';

/** Design fixtures for the tests: one task, two variants, under review. */

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
    createdAt: '2026-10-14T10:00:00.000Z',
    ...over,
  };
};

export const comment = (
  over: Partial<DesignCommentView> = {},
): DesignCommentView => ({
  id: 'c1',
  revisionId: 'rev-1-1',
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
  profileId: 'profile-1',
  approvedBy: null,
  approvedAt: null,
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
