import { randomUUID } from 'node:crypto';
import type {
  BoardCardKind,
  BoardColumn,
  PlanStatus,
  PlanTaskStatus,
} from '@nautelle/shared';
import type { Role } from '@prisma/client';
import { REPO, seedProject } from '../../fleet/testing/fleet-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../../test/e2e-app';

export const ROOT_A = '/srv/dev/widget';
export const ROOT_B = '/srv/dev/gadget';

/** `2026-10-15T10:00:00Z` plus `minutes`: every row's `updatedAt`. */
export const at = (minutes: number): Date =>
  new Date(Date.parse('2026-10-15T10:00:00Z') + minutes * 60_000);

/** What an issued task's issue looks like on GitHub (the live status, D2). */
export type IssueFact =
  // `unqueued`: issued, not queued yet — live `null`.
  'unqueued' | 'queued' | 'pr_open' | 'merged' | 'closed';

export interface TaskSeed {
  key: string;
  status?: PlanTaskStatus;
  kind?: 'feature' | 'bug';
  title?: string;
  updatedAt: Date;
  /** With `status: 'issued'`: the issue's number and what GitHub says. */
  issue?: { number: number; fact: IssueFact };
  design?: boolean;
}

export interface PlanSeed {
  project: string;
  author: string;
  title?: string;
  status?: PlanStatus;
  visibility?: 'private' | 'project';
  /** The current version; tasks are seeded into it. */
  version?: number;
}

export interface CardSeed {
  project: string;
  number: number;
  title?: string;
  kind?: BoardCardKind;
  column?: BoardColumn;
  updatedAt: Date;
  issueNumber?: number;
  /** #388: seeds a mirrored `fleet` card of this issue and slot. */
  fleet?: { issue: number; slot: string; stage?: string };
}

/**
 * The Work e2e world: projects A and B on one runner, and the people of
 * D11 — `admin`; `author` and `operator` (operators of A); `viewer` (a viewer
 * of A); `mixed` (an operator of A and a viewer of B, through a role
 * override on B); `outsider` (an operator of no project). Rows are written
 * through Prisma with explicit `updatedAt`, so ordering is exact.
 */
export class WorkWorld {
  ctx!: E2eContext;
  a!: string;
  b!: string;
  admin!: Session;
  author!: Session;
  operator!: Session;
  viewer!: Session;
  mixed!: Session;
  outsider!: Session;
  authorId!: string;
  operatorId!: string;
  private instructionsId!: string;
  private shortId = 0;

  async init(): Promise<void> {
    this.ctx = await createE2eApp();
  }

  async close(): Promise<void> {
    await this.ctx.app.close();
  }

  async reset(): Promise<void> {
    const { prisma } = this.ctx;
    await resetDatabase(prisma);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE runners, planner_instructions CASCADE',
    );
    let runnerId: string;
    ({ runnerId, projectId: this.a } = await seedProject(prisma, ROOT_A));
    ({ projectId: this.b } = await seedProject(prisma, ROOT_B, runnerId));
    await prisma.project.update({
      where: { id: this.b },
      data: { displayName: 'gadget' },
    });
    this.instructionsId = (
      await prisma.plannerInstructions.create({
        data: { projectId: null, version: 1, body: 'GLOBAL' },
      })
    ).id;

    const user = async (
      email: string,
      role: Role,
      projects: { id: string; override?: Role }[],
    ) => {
      const row = await createUser(prisma, email, role);
      for (const p of projects) {
        await prisma.projectMember.create({
          data: {
            projectId: p.id,
            userId: row.id,
            roleOverride: p.override ?? null,
          },
        });
      }
      return { id: row.id, session: await login(this.ctx, email) };
    };
    this.admin = (await user('admin@x.test', 'admin', [])).session;
    const author = await user('author@x.test', 'operator', [{ id: this.a }]);
    this.author = author.session;
    this.authorId = author.id;
    const operator = await user('op@x.test', 'operator', [{ id: this.a }]);
    this.operator = operator.session;
    this.operatorId = operator.id;
    this.viewer = (
      await user('viewer@x.test', 'viewer', [{ id: this.a }])
    ).session;
    this.mixed = (
      await user('mixed@x.test', 'operator', [
        { id: this.a },
        { id: this.b, override: 'viewer' },
      ])
    ).session;
    this.outsider = (await user('out@x.test', 'operator', [])).session;
  }

  /** A plan, and its tasks in its current version. */
  async plan(seed: PlanSeed, tasks: TaskSeed[]): Promise<string> {
    const { prisma } = this.ctx;
    const plan = await prisma.plan.create({
      data: {
        projectId: seed.project,
        authorId: seed.author,
        title: seed.title ?? 'Onboarding v2',
        brief: 'Build it',
        mode: 'batch',
        visibility: seed.visibility ?? 'project',
        status: seed.status ?? 'sent',
        version: seed.version ?? 1,
        sessionId: randomUUID(),
        instructionsId: this.instructionsId,
        contractVersion: 1,
        profileKey: 'claude-main',
        model: 'opus',
      },
    });
    for (const t of tasks) await this.task(plan.id, seed, t);
    return plan.id;
  }

  private async task(
    planId: string,
    plan: PlanSeed,
    seed: TaskSeed,
  ): Promise<void> {
    const { prisma } = this.ctx;
    const issue = seed.issue;
    await prisma.planTask.create({
      data: {
        planId,
        key: seed.key,
        planVersion: plan.version ?? 1,
        kind: seed.kind ?? 'feature',
        title: seed.title ?? `Task ${seed.key}`,
        summary: `Summary of ${seed.key}`,
        status: seed.status ?? (issue ? 'issued' : 'draft'),
        issueNumber: issue?.number ?? null,
        issueUrl: issue
          ? `https://github.com/${REPO}/issues/${issue.number}`
          : null,
        queuedAt: issue?.fact === 'queued' ? seed.updatedAt : null,
        updatedAt: seed.updatedAt,
      },
    });
    if (seed.design) {
      await prisma.taskDesign.create({
        data: {
          planId,
          taskKey: seed.key,
          needed: true,
          suggested: true,
          variantCount: 2,
        },
      });
    }
    if (!issue) return;
    if (issue.fact === 'pr_open') {
      await this.issueRow(plan.project, 900 + issue.number, {
        kind: 'pull_request',
        state: 'open',
        body: `Closes #${issue.number}`,
      });
    }
    if (issue.fact === 'merged' || issue.fact === 'closed') {
      await this.issueRow(plan.project, issue.number, {
        kind: 'issue',
        state: 'closed',
        body: '',
        closedBy: issue.fact === 'merged' ? 'pr' : 'manual',
        closingPr: issue.fact === 'merged' ? 900 + issue.number : null,
      });
    }
  }

  private issueRow(
    projectId: string,
    number: number,
    row: {
      kind: 'issue' | 'pull_request';
      state: 'open' | 'closed';
      body: string;
      closedBy?: 'pr' | 'manual';
      closingPr?: number | null;
    },
  ) {
    const path = row.kind === 'issue' ? 'issues' : 'pull';
    return this.ctx.prisma.issueCache.create({
      data: {
        projectId,
        number,
        kind: row.kind,
        title: `#${number}`,
        state: row.state,
        labels: [],
        assignees: [],
        body: row.body,
        url: `https://github.com/${REPO}/${path}/${number}`,
        ghUpdatedAt: at(0),
        closedBy: row.closedBy ?? null,
        closingPr: row.closingPr ?? null,
        snapshotAt: at(0),
        lastSeq: 1n,
      },
    });
  }

  async card(seed: CardSeed): Promise<string> {
    this.shortId += 1;
    const card = await this.ctx.prisma.boardCard.create({
      data: {
        projectId: seed.project,
        number: seed.number,
        shortId: `card${String(this.shortId).padStart(4, '0')}`,
        title: seed.title ?? `Card ${seed.number}`,
        kind: seed.kind ?? 'feature',
        column: seed.column ?? 'todo',
        source: seed.fleet
          ? 'fleet'
          : seed.column === 'inbox'
            ? 'captured'
            : 'manual',
        fleetIssue: seed.fleet?.issue ?? null,
        fleetSlot: seed.fleet?.slot ?? null,
        fleetStage: seed.fleet?.stage ?? null,
        position: seed.number,
        issueOnRun: false,
        specOnRun: false,
        movedAt: seed.updatedAt,
        issueNumber: seed.issueNumber ?? null,
        issueUrl: seed.issueNumber
          ? `https://github.com/${REPO}/issues/${seed.issueNumber}`
          : null,
        updatedAt: seed.updatedAt,
      },
    });
    return card.id;
  }
}
