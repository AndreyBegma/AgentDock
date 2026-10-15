import {
  DEFAULT_VIEWPORTS,
  type DesignCommentView,
  type DesignFailureView,
  type DesignOwnerView,
  type DesignProgressView,
  type DesignRevisionView,
  type DesignSkillWarning,
  type TaskDesignView,
  type ViewportPreset,
  viewportPresetsSchema,
} from '@agentdock/shared';
import type { Prisma } from '@prisma/client';
import { userRef, userSelect } from '../planner/plan-mapper';

/**
 * The design views (docs/specs/223-design-stage.md "API"). Pure.
 */

/** The mockup as the web reaches it: through its same-origin `/api` rewrite. */
export const mockupUrl = (revisionId: string): string =>
  `/api/design-revisions/${revisionId}/html`;

/** A stored viewport list; one that no longer parses reads as the defaults (D11). */
export const viewportsOf = (value: Prisma.JsonValue): ViewportPreset[] => {
  const parsed = viewportPresetsSchema.safeParse(value);
  return parsed.success ? parsed.data : [...DEFAULT_VIEWPORTS];
};

export const revisionSelect = {
  id: true,
  variant: true,
  revision: true,
  title: true,
  rationale: true,
  turnId: true,
  archived: true,
  createdAt: true,
} as const;

type RevisionRow = Prisma.DesignRevisionGetPayload<{
  select: typeof revisionSelect;
}>;

export const toRevisionView = (row: RevisionRow): DesignRevisionView => ({
  id: row.id,
  variant: row.variant,
  revision: row.revision,
  title: row.title,
  rationale: row.rationale,
  turnId: row.turnId,
  archived: row.archived,
  htmlUrl: mockupUrl(row.id),
  createdAt: row.createdAt.toISOString(),
});

export const commentInclude = { author: userSelect } as const;

type CommentRow = Prisma.DesignCommentGetPayload<{
  include: typeof commentInclude;
}>;

export const toCommentView = (row: CommentRow): DesignCommentView => ({
  id: row.id,
  revisionId: row.revisionId,
  kind: row.kind,
  viewport: row.viewport,
  theme: row.theme,
  x: row.x,
  y: row.y,
  selector: row.selector,
  body: row.body,
  author: row.author ? userRef(row.author) : null,
  addressedInRevisionId: row.addressedInRevisionId,
  createdAt: row.createdAt.toISOString(),
});

export const designInclude = {
  approvedBy: userSelect,
  card: { select: { id: true, number: true } },
  revisions: {
    select: revisionSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  comments: {
    include: commentInclude,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.TaskDesignInclude;

type DesignRow = Prisma.TaskDesignGetPayload<{
  include: typeof designInclude;
}>;

/** D15: a skill of the design that is no longer installed. */
export const skillWarnings = (
  skills: readonly string[],
  installed: ReadonlySet<string>,
): DesignSkillWarning[] =>
  skills
    .filter((s) => !installed.has(s))
    .map((skill) => ({
      skill,
      message: `${skill} is not installed for this project; design turns skip it`,
    }));

/**
 * ADR-0025: the owner of a design row — a plan task, or a board card. The
 * database's CHECK holds exactly one; a row with neither is a bug, not a view.
 */
export const ownerOf = (row: DesignRow): DesignOwnerView => {
  if (row.card) {
    return { kind: 'card', cardId: row.card.id, number: row.card.number };
  }
  if (row.planId === null || row.taskKey === null) {
    throw new Error(`design ${row.id} has no owner`);
  }
  return { kind: 'task', planId: row.planId, taskKey: row.taskKey };
};

export const toDesignView = (
  row: DesignRow,
  extra: {
    warnings: DesignSkillWarning[];
    viewports: ViewportPreset[];
    activeTurnId: string | null;
    progress: DesignProgressView | null;
    lastFailure: DesignFailureView | null;
  },
): TaskDesignView => ({
  id: row.id,
  owner: ownerOf(row),
  planId: row.planId,
  taskKey: row.taskKey,
  needed: row.needed,
  suggested: row.suggested,
  suggestionWhy: row.suggestionWhy,
  variantCount: row.variantCount,
  status: row.status,
  approvedRevisionId: row.approvedRevisionId,
  skills: row.skills,
  profileId: row.profileId,
  approvedBy: row.approvedBy ? userRef(row.approvedBy) : null,
  approvedAt: row.approvedAt?.toISOString() ?? null,
  revisions: row.revisions.map(toRevisionView),
  comments: row.comments.map(toCommentView),
  warnings: extra.warnings,
  viewports: extra.viewports,
  activeTurnId: extra.activeTurnId,
  busySince: row.busySince?.toISOString() ?? null,
  progress: extra.progress,
  lastFailure: extra.lastFailure,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
