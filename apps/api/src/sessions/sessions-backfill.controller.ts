import type { BackfillResponse } from '@agentdock/shared';
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import { Roles } from '../auth/decorators';
import { BackfillDto } from './dto';
import { SessionsBackfillService } from './sessions-backfill.service';

/** Spec 12 D11: admin only. The command is audited by `RunnerCommandService`. */
@Roles('admin')
@Controller('admin/runners')
export class SessionsBackfillController {
  constructor(private readonly backfill: SessionsBackfillService) {}

  @Post(':id/backfill')
  @HttpCode(200)
  run(
    @Param('id') id: string,
    @Body() dto: BackfillDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<BackfillResponse> {
    return this.backfill.backfill(id, dto, ctx);
  }
}
