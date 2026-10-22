import {
  DEFAULT_VIEWPORTS,
  DESIGN_ERROR,
  type DesignSettingsUpdateRequest,
  type DesignSettingsView,
  viewportPresetsSchema,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { userRef, userSelect } from '../planner/plan-mapper';
import { designError } from './design-error';
import { viewportsOf } from './design-mapper';

const include = { updatedBy: userSelect } as const;

type SettingsRow = Prisma.DesignSettingsGetPayload<{ include: typeof include }>;

const toView = (row: SettingsRow | null): DesignSettingsView =>
  row
    ? {
        viewports: viewportsOf(row.viewports),
        defaultSkills: row.defaultSkills,
        useMemory: row.useMemory,
        saved: true,
        updatedBy: row.updatedBy ? userRef(row.updatedBy) : null,
        updatedAt: row.updatedAt.toISOString(),
      }
    : {
        viewports: [...DEFAULT_VIEWPORTS],
        defaultSkills: [],
        useMemory: true,
        saved: false,
        updatedBy: null,
        updatedAt: null,
      };

/**
 * A project's design settings (docs/specs/223-design-stage.md D11, D15):
 * the viewer's viewport presets, the default design skills and (#752 A6)
 * whether design prompts read the profile's memory. No row reads as the
 * defaults; a project admin writes one.
 */
@Injectable()
export class DesignSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(projectId: string): Promise<DesignSettingsView> {
    return toView(
      await this.prisma.designSettings.findUnique({
        where: { projectId },
        include,
      }),
    );
  }

  async update(
    ctx: AuditContext,
    userId: string,
    projectId: string,
    request: DesignSettingsUpdateRequest,
  ): Promise<DesignSettingsView> {
    const viewports = viewportPresetsSchema.safeParse(request.viewports);
    if (!viewports.success) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        z.prettifyError(viewports.error),
      );
    }
    const defaultSkills = [...new Set(request.defaultSkills)];
    const before = await this.view(projectId);
    // #752 A6: left out, the switch keeps its state.
    const useMemory = request.useMemory ?? before.useMemory;
    const data = {
      viewports: viewports.data as Prisma.InputJsonValue,
      defaultSkills,
      useMemory,
      updatedById: userId,
    };
    const row = await this.prisma.designSettings.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
      include,
    });
    await this.audit.record({
      ...ctx,
      action: 'design.settings_updated',
      target: { type: 'project', id: projectId },
      projectId,
      before: {
        viewports: before.viewports,
        defaultSkills: before.defaultSkills,
        useMemory: before.useMemory,
      },
      after: { viewports: viewports.data, defaultSkills, useMemory },
      result: 'ok',
    });
    return toView(row);
  }
}
