import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsModule } from '../settings/settings.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditQueryService } from './audit-query.service';
import { AuditVerificationJob } from './audit-verification.job';
import { AuditVerificationService } from './audit-verification.service';

/** Global: every module records through `AuditService` (spec "Risks"). */
@Global()
@Module({
  imports: [ScheduleModule.forRoot(), SettingsModule],
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditQueryService,
    AuditVerificationService,
    AuditVerificationJob,
  ],
  exports: [AuditService],
})
export class AuditModule {}
