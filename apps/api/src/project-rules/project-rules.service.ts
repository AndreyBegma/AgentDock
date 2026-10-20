import {
  PROJECT_RULE_ERROR,
  type ProjectRuleCandidateInput,
  type ProjectRuleCreateRequest,
  type ProjectRuleImportResult,
  type ProjectRuleUpdateRequest,
  type ProjectRuleView,
  parseRulesMarkdown,
  ruleTitleKey,
  textFieldsSchema,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { ProjectRule } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectRuleError, projectRuleNotFound } from './project-rule-error';

export const ruleView = (row: ProjectRule): ProjectRuleView => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  description: row.description,
  enabled: row.enabled,
  position: row.position,
  source: row.source,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** What the audit log keeps of a rule. */
const audited = (row: ProjectRule) => ({
  id: row.id,
  title: row.title,
  enabled: row.enabled,
  position: row.position,
});

const ORDER = [{ position: 'asc' }, { createdAt: 'asc' }] as const;

/**
 * A project's coding rules (#528). Any member reads them; a project admin —
 * who also edits the project's other settings — writes them. Positions stay
 * dense and 0-based: create appends, delete closes the gap, reorder rewrites.
 * Every write is audited as a `project.update`.
 */
@Injectable()
export class ProjectRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(projectId: string): Promise<ProjectRuleView[]> {
    const rows = await this.prisma.projectRule.findMany({
      where: { projectId },
      orderBy: [...ORDER],
    });
    return rows.map(ruleView);
  }

  async create(
    projectId: string,
    input: ProjectRuleCreateRequest,
    ctx: AuditContext,
  ): Promise<ProjectRuleView> {
    const row = await this.prisma.projectRule.create({
      data: {
        projectId,
        title: input.title,
        description: input.description ?? '',
        enabled: input.enabled ?? true,
        position: await this.nextPosition(projectId),
      },
    });
    await this.record(projectId, ctx, {}, { rule: audited(row) }, 'create');
    return ruleView(row);
  }

  async update(
    projectId: string,
    ruleId: string,
    input: ProjectRuleUpdateRequest,
    ctx: AuditContext,
  ): Promise<ProjectRuleView> {
    const before = await this.find(projectId, ruleId);
    const row = await this.prisma.projectRule.update({
      where: { id: before.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
    await this.record(
      projectId,
      ctx,
      { rule: audited(before) },
      { rule: audited(row) },
      'update',
    );
    return ruleView(row);
  }

  async remove(
    projectId: string,
    ruleId: string,
    ctx: AuditContext,
  ): Promise<void> {
    const rule = await this.find(projectId, ruleId);
    await this.prisma.$transaction([
      this.prisma.projectRule.delete({ where: { id: rule.id } }),
      this.prisma.projectRule.updateMany({
        where: { projectId, position: { gt: rule.position } },
        data: { position: { decrement: 1 } },
      }),
    ]);
    await this.record(projectId, ctx, { rule: audited(rule) }, {}, 'delete');
  }

  /** `ruleIds` must name every rule of the project exactly once. */
  async reorder(
    projectId: string,
    ruleIds: readonly string[],
    ctx: AuditContext,
  ): Promise<ProjectRuleView[]> {
    const current = await this.prisma.projectRule.findMany({
      where: { projectId },
      orderBy: [...ORDER],
      select: { id: true },
    });
    const known = new Set(current.map((r) => r.id));
    const exact =
      ruleIds.length === known.size &&
      new Set(ruleIds).size === ruleIds.length &&
      ruleIds.every((id) => known.has(id));
    if (!exact) {
      throw projectRuleError(
        409,
        PROJECT_RULE_ERROR.orderMismatch,
        'The order must list every rule of the project exactly once',
      );
    }
    await this.prisma.$transaction(
      ruleIds.map((id, position) =>
        this.prisma.projectRule.update({ where: { id }, data: { position } }),
      ),
    );
    await this.record(
      projectId,
      ctx,
      { ruleOrder: current.map((r) => r.id) },
      { ruleOrder: [...ruleIds] },
      'reorder',
    );
    return this.list(projectId);
  }

  /**
   * One enabled rule per section of `markdown` (`parseRulesMarkdown`),
   * appended in document order. A title already on the project, or repeated
   * in the document, is skipped and reported.
   */
  async import(
    projectId: string,
    markdown: string,
    ctx: AuditContext,
  ): Promise<ProjectRuleImportResult> {
    const parsed = parseRulesMarkdown(markdown);
    const existing = await this.prisma.projectRule.findMany({
      where: { projectId },
      select: { title: true },
    });
    const taken = new Set(existing.map((r) => ruleTitleKey(r.title)));
    const fresh = parsed.rules.filter((r) => !taken.has(ruleTitleKey(r.title)));
    const skippedTitles = [
      ...parsed.rules
        .filter((r) => taken.has(ruleTitleKey(r.title)))
        .map((r) => r.title),
      ...parsed.duplicates,
    ];

    const start = await this.nextPosition(projectId);
    const rows =
      fresh.length === 0
        ? []
        : await this.prisma.$transaction(
            fresh.map((rule, i) =>
              this.prisma.projectRule.create({
                data: {
                  projectId,
                  title: rule.title,
                  description: rule.description,
                  enabled: true,
                  position: start + i,
                  source: 'imported',
                },
              }),
            ),
          );
    if (rows.length > 0) {
      await this.record(
        projectId,
        ctx,
        {},
        { rules: rows.map(audited) },
        'import',
        { skipped: skippedTitles.length },
      );
    }
    return {
      created: rows.length,
      skipped: skippedTitles.length,
      rules: rows.map(ruleView),
      skippedTitles,
    };
  }

  /**
   * #584: the accepted scan candidates, appended in order as enabled rules
   * with source `scanned`. A title already taken (`takenTitleKeys`), or
   * repeated in the request, is skipped and reported, as an import does.
   */
  async addScanned(
    projectId: string,
    candidates: readonly ProjectRuleCandidateInput[],
    ctx: AuditContext,
  ): Promise<ProjectRuleImportResult> {
    const taken = await this.takenTitleKeys(projectId);
    const fresh: ProjectRuleCandidateInput[] = [];
    const skippedTitles: string[] = [];
    for (const candidate of candidates) {
      const key = ruleTitleKey(candidate.title);
      if (taken.has(key)) {
        skippedTitles.push(candidate.title);
      } else {
        taken.add(key);
        fresh.push(candidate);
      }
    }

    const start = await this.nextPosition(projectId);
    const rows =
      fresh.length === 0
        ? []
        : await this.prisma.$transaction(
            fresh.map((rule, i) =>
              this.prisma.projectRule.create({
                data: {
                  projectId,
                  title: rule.title,
                  description: rule.description,
                  enabled: true,
                  position: start + i,
                  source: 'scanned',
                },
              }),
            ),
          );
    if (rows.length > 0) {
      await this.record(
        projectId,
        ctx,
        {},
        { rules: rows.map(audited) },
        'scan',
        {
          skipped: skippedTitles.length,
          sources: [...new Set(fresh.map((c) => c.source))],
        },
      );
    }
    return {
      created: rows.length,
      skipped: skippedTitles.length,
      rules: rows.map(ruleView),
      skippedTitles,
    };
  }

  /**
   * The title keys a scanned candidate must not repeat: every rule's title
   * as it is now, and as it was typed before its translation to English
   * (ADR-0027), so a rescan of a guide in another language finds its rules.
   */
  async takenTitleKeys(projectId: string): Promise<Set<string>> {
    const [rules, originals] = await Promise.all([
      this.prisma.projectRule.findMany({
        where: { projectId },
        select: { title: true },
      }),
      this.prisma.textNormalization.findMany({
        where: { projectId, ownerType: 'project_rule', ruleId: { not: null } },
        select: { fields: true },
      }),
    ]);
    const keys = new Set(rules.map((r) => ruleTitleKey(r.title)));
    for (const row of originals) {
      const fields = textFieldsSchema.safeParse(row.fields);
      if (!fields.success) continue;
      for (const field of fields.data) {
        if (field.field === 'title') keys.add(ruleTitleKey(field.original));
      }
    }
    return keys;
  }

  /** A rule of `projectId`; another project's rule is not found. */
  private async find(projectId: string, ruleId: string): Promise<ProjectRule> {
    const rule = await this.prisma.projectRule.findFirst({
      where: { id: ruleId, projectId },
    });
    if (!rule) throw projectRuleNotFound();
    return rule;
  }

  private async nextPosition(projectId: string): Promise<number> {
    const last = await this.prisma.projectRule.aggregate({
      where: { projectId },
      _max: { position: true },
    });
    return (last._max.position ?? -1) + 1;
  }

  private record(
    projectId: string,
    ctx: AuditContext,
    before: object,
    after: object,
    change: string,
    meta: object = {},
  ): Promise<void> {
    return this.audit.record({
      ...ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before,
      after,
      result: 'ok',
      meta: { rules: change, ...meta },
    });
  }
}
