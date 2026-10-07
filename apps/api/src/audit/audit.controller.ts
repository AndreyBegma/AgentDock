import { once } from 'node:events';
import type {
  AuditPage,
  AuditRecordView,
  AuditVerification,
  AuditVerificationState,
} from '@agentdock/shared';
import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/decorators';
import { AuditQueryService, auditNotFound } from './audit-query.service';
import { AuditVerificationService } from './audit-verification.service';
import { AuditFiltersQuery, ListAuditQuery, SEQ_PATTERN } from './dto';

/** Admin only (D11). Read and verify — no route modifies a record. */
@Roles('admin')
@Controller('admin/audit')
export class AuditController {
  constructor(
    private readonly query: AuditQueryService,
    private readonly verification: AuditVerificationService,
  ) {}

  @Get()
  list(@Query() query: ListAuditQuery): Promise<AuditPage> {
    const { cursor, limit, ...filters } = query;
    return this.query.list(filters, cursor, limit);
  }

  @Get('verification')
  async lastVerification(): Promise<AuditVerificationState> {
    return { last: await this.verification.last() };
  }

  @Post('verification')
  @HttpCode(200)
  verify(): Promise<AuditVerification> {
    return this.verification.verifyAndStore();
  }

  /** Streamed (D12): rows are written as they are read, never all in memory. */
  @Get('export.csv')
  async exportCsv(
    @Query() filters: AuditFiltersQuery,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="audit-records.csv"',
    );
    for await (const chunk of this.query.exportCsv(filters)) {
      if (!response.write(chunk)) await once(response, 'drain');
    }
    response.end();
  }

  @Get(':seq')
  detail(@Param('seq') seq: string): Promise<AuditRecordView> {
    if (!SEQ_PATTERN.test(seq)) throw auditNotFound();
    return this.query.get(BigInt(seq));
  }
}
