import { Module } from '@nestjs/common';
import { CryptoModule } from '../../common/crypto';
import { SettingsModule } from '../../settings/settings.module';
import { WebhookSecrets } from './secrets';
import { WebhookSettingsService } from './webhook-settings.service';
import { WEBHOOKS_OPTIONS, webhooksOptionsFromEnv } from './webhooks-options';

/**
 * What inbound triggers and outbound webhooks share (docs/specs/26-webhooks.md):
 * secrets at rest (D17), the private-target allowlist (D15) and the module's
 * options. The signature helpers, the SSRF guard and raw body capture are
 * plain functions beside it.
 */
@Module({
  imports: [CryptoModule, SettingsModule],
  providers: [
    { provide: WEBHOOKS_OPTIONS, useFactory: () => webhooksOptionsFromEnv() },
    WebhookSecrets,
    WebhookSettingsService,
  ],
  exports: [WEBHOOKS_OPTIONS, WebhookSecrets, WebhookSettingsService],
})
export class WebhooksCommonModule {}
