import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { CommandRunsService } from '../../control/command-runs.service';
import { ControlService } from '../../control/control.service';
import {
  CONTROL_OPTIONS,
  defaultControlOptions,
} from '../../control/control-options';
import { OrchestratorSettingsService } from '../../control/orchestrator-settings.service';
import { LiveModule } from '../../live/live.module';
import { RunnersModule } from '../../runners/runners.module';
import { SkillsModule } from '../../skills';
import { WebhooksCommonModule } from '../common';
import { HooksController } from './hooks.controller';
import { InboundHookService } from './inbound-hook.service';
import { InboundLive } from './inbound-live';
import { TriggerFirer } from './trigger-firer';
import { TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';

/**
 * Inbound triggers (docs/specs/26-webhooks.md D1–D7): `POST /hooks/:publicId`,
 * argument templating, firing, and `/admin/triggers*`. A firing goes through
 * `SkillRunService` (#24) or `ControlService` (#17) — the paths a person's
 * click takes, with their gates.
 *
 * `ControlModule` does not export `ControlService`; it and its helpers are
 * stateless, so this module provides its own instances, as `SchedulesModule`
 * does.
 */
@Module({
  imports: [WebhooksCommonModule, LiveModule, RunnersModule, SkillsModule],
  controllers: [HooksController, TriggersController],
  providers: [
    CommandRunsService,
    ControlService,
    OrchestratorSettingsService,
    { provide: CONTROL_OPTIONS, useValue: defaultControlOptions },
    InboundHookService,
    InboundLive,
    TriggerFirer,
    TriggersService,
  ],
})
export class InboundWebhooksModule implements OnApplicationShutdown {
  constructor(private readonly firer: TriggerFirer) {}

  /** Lets firings already past their 202 finish writing their outcome. */
  onApplicationShutdown(): Promise<void> {
    return this.firer.drain();
  }
}
