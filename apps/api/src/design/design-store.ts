import {
  DESIGN_COMMENTS_PER_TURN_MAX,
  DESIGN_LEGACY_FRAME_NAME,
  type DesignSuggestion,
  designFrameSlug,
  type TaskDesignSummary,
  type UiProfileSnippet,
  uiProfileSnippetSchema,
} from '@agentdock/shared';
import type { Prisma, TaskDesignStatus, UiProfile } from '@prisma/client';
import { z } from 'zod';
import type { PrismaService } from '../database/prisma.service';
import {
  type ApprovedDesignContext,
  anchorOf,
  type DesignPromptContext,
  type StackDesignReference,
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
  | { cardId: string }
  /** #480 (ADR-0044): a stack's shared design. */
  | { stackId: string };

/** The unique `task_designs` lookup of an owner. */
export const designWhere = (
  key: DesignKey,
): Prisma.TaskDesignWhereUniqueInput =>
  'cardId' in key
    ? { cardId: key.cardId }
    : 'stackId' in key
      ? { stackId: key.stackId }
      : { planId_taskKey: { planId: key.planId, taskKey: key.taskKey } };

/** #243 D2: a card's design turns answer the contract under this `taskKey`. */
export const cardDesignTaskKey = (number: number): string => `card-${number}`;

/** #480: a stack's design turns answer the contract under this `taskKey`. */
export const stackDesignTaskKey = (number: number): string => `stack-${number}`;

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

/** #604: the fields of a design that decide where its skills come from. */
export interface DesignSkillsSource {
  skills: string[];
  skillsEdited: boolean;
  status: TaskDesignStatus;
}

/**
 * #604: a design follows the project's default skills until they are edited
 * by hand on its panel, and until it is first generated — Generate copies the
 * default in, and that batch and every later turn keep the copy.
 */
export const followsDefaultSkills = (
  design: Omit<DesignSkillsSource, 'skills'>,
  drawn: boolean,
): boolean => !design.skillsEdited && !drawn && design.status === 'idle';

/** #604: the skills the next turn of `design` applies, before the installed check. */
export const designSkillsOf = (
  design: DesignSkillsSource,
  drawn: boolean,
  defaults: readonly string[],
): string[] =>
  followsDefaultSkills(design, drawn) ? [...defaults] : design.skills;

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
      busySince: true,
    },
  });
  return new Map(
    rows.flatMap(({ taskKey, busySince, ...summary }) =>
      taskKey === null
        ? []
        : [
            [
              taskKey,
              { ...summary, busySince: busySince?.toISOString() ?? null },
            ] as const,
          ],
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

/** #441: a frame's name and slug, in order, without its HTML. */
export interface FrameName {
  name: string;
  slug: string;
}

/** #441: a frame with its HTML, as publication commits it. */
export interface FrameFile extends FrameName {
  html: string;
}

/** The frame a revision stored before #441 reads as. */
export const LEGACY_FRAME: FrameName = {
  name: DESIGN_LEGACY_FRAME_NAME,
  slug: designFrameSlug(DESIGN_LEGACY_FRAME_NAME),
};

/** A revision's frame names: its rows, or the one legacy frame. */
export const frameNamesOf = (rows: readonly FrameName[]): FrameName[] =>
  rows.length > 0
    ? rows.map(({ name, slug }) => ({ name, slug }))
    : [LEGACY_FRAME];

/** The `frames` select of a revision: names in order, no HTML. */
export const frameNameSelect = {
  select: { name: true, slug: true },
  orderBy: { position: 'asc' },
} as const;

/**
 * #441: every frame of a revision with its HTML, in order. A revision stored
 * before frames holds its one mockup in `html` and reads as one frame.
 */
export const revisionFrames = async (
  db: Db,
  revisionId: string,
): Promise<FrameFile[]> => {
  const revision = await db.designRevision.findUniqueOrThrow({
    where: { id: revisionId },
    select: {
      html: true,
      frames: {
        select: { name: true, slug: true, html: true },
        orderBy: { position: 'asc' },
      },
    },
  });
  if (revision.frames.length > 0) return revision.frames;
  return [{ ...LEGACY_FRAME, html: revision.html ?? '' }];
};

/** The frame's name at `position` of a revision, for a comment's anchor. */
const frameNameAt = (frames: readonly FrameName[], position: number): string =>
  frameNamesOf(frames)[position]?.name ?? DESIGN_LEGACY_FRAME_NAME;

/** A revision's variant, number and frames, for a comment's `leftOn`. */
const revisionSelect = {
  select: { variant: true, revision: true, frames: frameNameSelect },
} as const;

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
          select: {
            revision: true,
            title: true,
            rationale: true,
            frames: frameNameSelect,
          },
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
    previous: previous
      ? {
          revision: previous.revision,
          title: previous.title,
          rationale: previous.rationale,
          frames: frameNamesOf(previous.frames).map((f) => f.name),
        }
      : null,
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
      frame: frameNameAt(c.revision.frames, c.frame),
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
 * D16: the approved design of a task, for its write turn — its frames'
 * names without their paths, which the planner names. Null when the design
 * is off or not approved.
 */
export const loadApprovedDesign = async (
  db: Db,
  planId: string,
  taskKey: string,
): Promise<
  | (Omit<ApprovedDesignContext, 'dir' | 'frames'> & { frames: FrameName[] })
  | null
> => {
  const design = await db.taskDesign.findUnique({
    where: { planId_taskKey: { planId, taskKey } },
    include: {
      approvedRevision: {
        select: {
          variant: true,
          title: true,
          rationale: true,
          frames: frameNameSelect,
        },
      },
      comments: {
        include: { revision: revisionSelect },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!design?.needed || !design.approvedRevision) return null;
  const { variant, title, rationale, frames } = design.approvedRevision;
  return {
    variant,
    title,
    rationale,
    frames: frameNamesOf(frames),
    // The comments left on the picked variant; the others' were about a
    // layout that was not chosen.
    decisions: design.comments
      .filter((c) => c.revision.variant === variant)
      .map((c) => ({
        kind: c.kind,
        frame: frameNameAt(c.revision.frames, c.frame),
        anchor: anchorOf(c),
        body: c.body,
      })),
  };
};

/**
 * #480 (ADR-0044): the approved design of the stack a card belongs to, as the
 * card's design turn reads it for reference. Null when the card is in no
 * stack, or its stack's design is off or not approved.
 */
export const loadStackReference = async (
  db: Db,
  cardId: string,
): Promise<StackDesignReference | null> => {
  const card = await db.boardCard.findUnique({
    where: { id: cardId },
    select: {
      stage: {
        select: {
          stack: {
            select: {
              number: true,
              title: true,
              design: {
                select: {
                  needed: true,
                  status: true,
                  approvedRevision: {
                    select: { id: true, title: true, rationale: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const stack = card?.stage?.stack;
  const approved = stack?.design?.approvedRevision;
  if (
    !stack ||
    !approved ||
    !stack.design?.needed ||
    stack.design.status !== 'approved'
  ) {
    return null;
  }
  const frames = await revisionFrames(db, approved.id);
  return {
    label: `S-${stack.number}`,
    title: stack.title,
    revisionTitle: approved.title,
    rationale: approved.rationale,
    frames: frames.map((f) => ({ name: f.name, html: f.html })),
  };
};
