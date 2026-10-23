import {
  BUILTIN_DESIGN_TEMPLATES,
  builtinDesignTemplate,
  builtinOverrideProblems,
  DESIGN_ERROR,
  DESIGN_TEMPLATE_KEY_MAX,
  DESIGN_TEMPLATE_KEY_PATTERN,
  type DesignTemplate,
  type DesignTemplatesView,
  type DesignTemplateUpsertRequest,
  type DesignTemplateView,
  designTemplateSchema,
  resolveDesignTemplate,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { designError } from '../design/design-error';
import { userRef, userSelect } from '../planner/plan-mapper';

const include = { updatedBy: userSelect } as const;

type TemplateRow = Prisma.DesignTemplateGetPayload<{ include: typeof include }>;

/** The stored definition as a template, or null when it no longer parses. */
const parsed = (row: TemplateRow): DesignTemplate | null => {
  const result = designTemplateSchema.safeParse({
    ...(typeof row.definition === 'object' && row.definition !== null
      ? row.definition
      : {}),
    key: row.key,
    name: row.name,
  });
  return result.success ? result.data : null;
};

const view = (
  template: DesignTemplate,
  builtin: boolean,
  row: TemplateRow | undefined,
): DesignTemplateView => ({
  ...template,
  builtin,
  overridden: row !== undefined,
  updatedBy: row?.updatedBy ? userRef(row.updatedBy) : null,
  updatedAt: row ? row.updatedAt.toISOString() : null,
});

/**
 * A project's design templates (docs/specs/833-standard-design-frame-templates.md
 * D9, ADR-0082): the three built-ins with the project's override merged in,
 * and the project's own. A row under a built-in key is an override; any other
 * key is a custom template. A project admin writes them; every change is
 * audited.
 */
@Injectable()
export class DesignTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(projectId: string): Promise<DesignTemplatesView> {
    const rows = await this.prisma.designTemplate.findMany({
      where: { projectId },
      include,
      orderBy: { key: 'asc' },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const templates: DesignTemplateView[] = [];
    for (const builtin of BUILTIN_DESIGN_TEMPLATES) {
      const row = byKey.get(builtin.key);
      const resolved = resolveDesignTemplate(builtin, row ? parsed(row) : null);
      if (resolved) templates.push(view(resolved, true, row));
    }
    for (const row of rows) {
      if (builtinDesignTemplate(row.key)) continue;
      const template = parsed(row);
      if (template) templates.push(view(template, false, row));
    }
    return { templates };
  }

  async upsert(
    ctx: AuditContext,
    userId: string,
    projectId: string,
    key: string,
    request: DesignTemplateUpsertRequest,
  ): Promise<DesignTemplateView> {
    this.assertKey(key);
    const checked = designTemplateSchema.safeParse({
      key,
      name: request.name,
      frames: request.frames,
    });
    if (!checked.success) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        z.prettifyError(checked.error),
      );
    }
    const builtin = builtinDesignTemplate(key);
    if (builtin) {
      const problems = builtinOverrideProblems(builtin, checked.data);
      if (problems.length > 0) {
        throw designError(400, DESIGN_ERROR.invalidArgs, problems.join('; '));
      }
    }
    const before = await this.prisma.designTemplate.findUnique({
      where: { projectId_key: { projectId, key } },
      include,
    });
    const definition = {
      frames: checked.data.frames,
    } as unknown as Prisma.InputJsonValue;
    const data = { name: checked.data.name, definition, updatedById: userId };
    const row = await this.prisma.designTemplate.upsert({
      where: { projectId_key: { projectId, key } },
      create: { projectId, key, ...data },
      update: data,
      include,
    });
    await this.audit.record({
      ...ctx,
      action: before ? 'design.template_updated' : 'design.template_created',
      target: { type: 'design_template', id: row.id },
      projectId,
      before: before
        ? { key, name: before.name, definition: before.definition }
        : undefined,
      after: { key, name: row.name, frames: checked.data.frames },
      result: 'ok',
    });
    const resolved = resolveDesignTemplate(builtin, checked.data);
    return view(resolved as DesignTemplate, builtin !== undefined, row);
  }

  /** Deletes a custom template, or resets a built-in's override. */
  async remove(
    ctx: AuditContext,
    projectId: string,
    key: string,
  ): Promise<void> {
    this.assertKey(key);
    const row = await this.prisma.designTemplate.findUnique({
      where: { projectId_key: { projectId, key } },
    });
    if (!row) {
      // Resetting a built-in with no override is already done.
      if (builtinDesignTemplate(key)) return;
      throw designError(404, DESIGN_ERROR.notFound, 'No such design template');
    }
    await this.prisma.designTemplate.delete({ where: { id: row.id } });
    await this.audit.record({
      ...ctx,
      action: 'design.template_deleted',
      target: { type: 'design_template', id: row.id },
      projectId,
      before: { key, name: row.name, definition: row.definition },
      result: 'ok',
    });
  }

  private assertKey(key: string): void {
    if (
      key.length > DESIGN_TEMPLATE_KEY_MAX ||
      !DESIGN_TEMPLATE_KEY_PATTERN.test(key)
    ) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        'A template key is lowercase letters, digits, - and _, and starts with a letter',
      );
    }
  }
}
