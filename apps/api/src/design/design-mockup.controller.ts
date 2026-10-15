import { DESIGN_ERROR } from '@agentdock/shared';
import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type AuthUser, CurrentUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { readablePlanWhere } from '../planner/plan-access';
import { ProjectAccessService } from '../projects';
import { designError } from './design-error';
import { sendMockup } from './mockup-response';

/**
 * The mockup endpoint (docs/specs/223-design-stage.md "API", D6, D9).
 *
 * It serves a revision's HTML for the viewer's iframe through `sendMockup`:
 * the mockup headers over helmet's, so the document has an opaque origin
 * even though the web reaches it through its same-origin `/api` rewrite,
 * and the pin helper injected, never stored.
 *
 * Read follows the design's owner (ADR-0025): for a plan task, a member of
 * the project who may read the revision's plan (D17); for a board card, any
 * member of its project (#243 D8). Anything else is 404, as if absent.
 */
@Controller('design-revisions')
export class DesignMockupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get(':id/html')
  async html(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const revision = await this.prisma.designRevision.findUnique({
      where: { id },
      select: {
        html: true,
        design: {
          select: {
            plan: { select: { id: true, projectId: true } },
            card: { select: { projectId: true } },
          },
        },
      },
    });
    const owner = revision?.design;
    let readable = false;
    if (owner?.plan) {
      readable =
        (await this.access.resolve(user, owner.plan.projectId)) !== null &&
        (await this.prisma.plan.count({
          where: { id: owner.plan.id, ...readablePlanWhere(user.id) },
        })) > 0;
    } else if (owner?.card) {
      // #243 D8: a card's design is the project's — every member reads it.
      readable =
        (await this.access.resolve(user, owner.card.projectId)) !== null;
    }
    if (!revision || !readable) {
      throw designError(404, DESIGN_ERROR.notFound, 'Design not found');
    }
    sendMockup(res, revision.html);
  }
}
