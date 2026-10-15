import {
  DESIGN_COMMENTS_PER_TURN_MAX,
  type DesignSuggestion,
  type TaskDesignSummary,
  type UiProfileSnippet,
  uiProfileSnippetSchema,
} from '@agentdock/shared';
import type { Prisma, UiProfile } from '@prisma/client';
import { z } from 'zod';
import type { PrismaService } from '../database/prisma.service';
import {
  type ApprovedDesignContext,
  anchorOf,
  type DesignPromptContext,
} from './design-prompt';
import {
  type DesignGate,
  type DesignTurnPlan,
  suggestionOf,
  suggestionUpdate,
} from './design-rules';

/**
 * Reads and writes of the design stage that the planner shares with the
 * design flow (docs/specs/223-design-stage.md). Plain functions over a
 * client or a transaction, so the planner calls them without depending on
 * the design module.
 */

export type Db = Prisma.TransactionClient | PrismaService;

/**
 * ADR-0025: the owner of a design row — a plan task, or a board card (#243).
 * Every read and write of one design goes through its owner's key.
 */
export type DesignKey =
  | { planId: string; taskKey: string }
  | { cardId: string };

/** The unique `task_designs` lookup of an owner. */
export const designWhere = (
  key: DesignKey,
): Prisma.TaskDesignWhereUniqueInput =>
  'cardId' in key
    ? { cardId: key.cardId }
    : { planId_taskKey: { planId: key.planId, taskKey: key.taskKey } };

/** #243 D2: a card's design turns answer the contract under this `taskKey`. */
export const cardDesignTaskKey = (number: number): string => `card-${number}`;

/** The project's current profile version: the highest. */
export const currentProfile = (
  db: Db,
  projectId: string,
): Promise<UiProfile | null> =>
  db.uiProfile.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
  });

/** D3: whether the current profile reports a UI; null with no profile. */
export const profileHasUi = async (
  db: Db,
  projectId: string,
): Promise<boolean | null> => {
  const profile = await db.uiProfile.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { hasUi: true },
  });
  return profile?.hasUi ?? null;
};

/** A stored snippet list; one that no longer parses reads as empty. */
export const snippetsOf = (value: Prisma.JsonValue): UiProfileSnippet[] => {
  const parsed = z.array(uiProfileSnippetSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
};

/** D15: the project's default design skills; none without a settings row. */
export const defaultSkillsOf = async (
  db: Db,
  projectId: string,
): Promise<string[]> => {
  const settings = await db.designSettings.findUnique({
    where: { projectId },
    select: { defaultSkills: true },
  });
  return settings?.defaultSkills ?? [];
};

/**
 * D15: the skills of `invocations` installed where the project's runs see
 * them — the runner's profile and plugin skills, and the project's own (the
 * scope `SkillInventoryService` lists).
 */
export const installedOf = async (
  db: Db,
  project: { id: string; runnerId: string },
  invocations: readonly string[],
): Promise<Set<string>> => {
  if (invocations.length === 0) return new Set();
  const rows = await db.installedSkill.findMany({
    where: {
      runnerId: project.runnerId,
      invocation: { in: [...invocations] },
      OR: [
        { scope: { in: ['profile', 'plugin'] } },
        { scope: 'project', projectId: project.id },
      ],
    },
    select: { invocation: true },
  });
  return new Set(rows.map((r) => r.invocation));
};

/** Every design of a plan, by task key, as the task status rule reads it. */
export const designGates = async (
  db: Db,
  planId: string,
): Promise<Map<string, DesignGate>> => {
  const rows = await db.taskDesign.findMany({
    where: { planId },
    select: { taskKey: true, needed: true, status: true },
  });
  return new Map(
    rows.flatMap((r) => (r.taskKey === null ? [] : [[r.taskKey, r] as const])),
  );
};

/** Every design of a plan, by task key, as a task card shows it. */
export const designSummaries = async (
  db: Db,
  planId: string,
): Promise<Map<string, TaskDesignSummary>> => {
  const rows = await db.taskDesign.findMany({
    where: { planId },
    select: {
      taskKey: true,
      needed: true,
      suggested: true,
      suggestionWhy: true,
      variantCount: true,
      status: true,
      approvedRevisionId: true,
    },
  });
  return new Map(
    rows.flatMap(({ taskKey, ...summary }) =>
      taskKey === null
        ? []
        : [[taskKey, { ...summary, busySince: null }] as const],
    ),
  );
};

/**
 * D2, D3: the planner's suggestions of a decompose, grill or revise, written
 * to the plan's designs. A task with no row gets one only when the
 * suggestion is on; an existing row keeps the person's switch.
 */
export const applySuggestions = async (
  tx: Prisma.TransactionClient,
  plan: { id: string; projectId: string },
  tasks: readonly { key: string; design?: DesignSuggestion }[],
): Promise<void> => {
  const suggesting = tasks.filter(
    (t): t is { key: string; design: DesignSuggestion } =>
      t.design !== undefined,
  );
  if (suggesting.length === 0) return;
  const hasUi = await profileHasUi(tx, plan.projectId);
  const existing = await tx.taskDesign.findMany({
    where: { planId: plan.id, taskKey: { in: suggesting.map((t) => t.key) } },
    select: {
      id: true,
      taskKey: true,
      status: true,
      _count: { select: { revisions: true } },
    },
  });
  const byKey = new Map(existing.map((r) => [r.taskKey, r]));
  let skills: string[] | null = null;
  for (const t of suggesting) {
    const suggestion = suggestionOf(t.design, hasUi);
    const row = byKey.get(t.key);
    if (row) {
      await tx.taskDesign.update({
        where: { id: row.id },
        data: suggestionUpdate(suggestion, {
          status: row.status,
          drawn: row._count.revisions > 0,
        }),
      });
    } else if (suggestion.needed) {
      skills ??= await defaultSkillsOf(tx, plan.projectId);
      await tx.taskDesign.create({
        data: { planId: plan.id, taskKey: t.key, ...suggestion, skills },
      });
    }
  }
};

/** A revision's variant and number, for a comment's `leftOn`. */
const revisionSelect = { select: { variant: true, revision: true } } as const;

/**
 * D8: what a design turn carries — the profile it draws from, the design's
 * installed skills, the variant's latest revision on a revise, and the
 * comments open when its batch started.
 */
export const loadDesignPrompt = async (
  db: Db,
  project: { id: string; runnerId: string },
  design: { id: string; variantCount: number; skills: string[] },
  plan: DesignTurnPlan,
): Promise<DesignPromptContext> => {
  const [profile, installed, previous, comments] = await Promise.all([
    plan.profileId
      ? db.uiProfile.findUnique({ where: { id: plan.profileId } })
      : Promise.resolve(null),
    installedOf(db, project, design.skills),
    plan.mode === 'revise'
      ? db.designRevision.findFirst({
          where: { designId: design.id, variant: plan.variant },
          orderBy: { revision: 'desc' },
          select: { revision: true, title: true, rationale: true },
        })
      : Promise.resolve(null),
    plan.comments.length > 0
      ? db.designComment.findMany({
          where: { designId: design.id, id: { in: plan.comments } },
          include: { revision: revisionSelect },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: DESIGN_COMMENTS_PER_TURN_MAX,
        })
      : Promise.resolve([]),
  ]);
  return {
    variant: plan.variant,
    variantCount: design.variantCount,
    mode: plan.mode,
    previous,
    profile: profile
      ? {
          version: profile.version,
          hasUi: profile.hasUi,
          summary: profile.summary,
          kit: profile.kit,
          snippets: snippetsOf(profile.snippets),
        }
      : null,
    skills: design.skills.filter((s) => installed.has(s)),
    comments: comments.map((c) => ({
      id: c.id,
      kind: c.kind,
      variant: c.revision.variant,
      revision: c.revision.revision,
      viewport: c.viewport,
      theme: c.theme,
      x: c.x,
      y: c.y,
      selector: c.selector,
      body: c.body,
    })),
  };
};

/**
 * D16: the approved design of a task, for its write turn — without the path,
 * which the planner names. Null when the design is off or not approved.
 */
export const loadApprovedDesign = async (
  db: Db,
  planId: string,
  taskKey: string,
): Promise<Omit<ApprovedDesignContext, 'path'> | null> => {
  const design = await db.taskDesign.findUnique({
    where: { planId_taskKey: { planId, taskKey } },
    include: {
      approvedRevision: {
        select: { variant: true, title: true, rationale: true },
      },
      comments: {
        include: { revision: revisionSelect },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!design?.needed || !design.approvedRevision) return null;
  const { variant, title, rationale } = design.approvedRevision;
  return {
    variant,
    title,
    rationale,
    // The comments left on the picked variant; the others' were about a
    // layout that was not chosen.
    decisions: design.comments
      .filter((c) => c.revision.variant === variant)
      .map((c) => ({
        kind: c.kind,
        anchor: anchorOf(c),
        body: c.body,
      })),
  };
};
