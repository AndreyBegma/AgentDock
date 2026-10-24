import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import {
  PRODUCT_RELEASE_OPTIONS,
  productReleaseOptionsFromEnv,
} from './product-release';
import { ProductReleaseService } from './product-release.service';
import { UpdatesController } from './updates.controller';

/** C-374: the daily check for a newer Nautelle release (ADR-0090). */
@Module({
  imports: [SettingsModule],
  controllers: [UpdatesController],
  providers: [
    {
      provide: PRODUCT_RELEASE_OPTIONS,
      useFactory: () => productReleaseOptionsFromEnv(),
    },
    ProductReleaseService,
  ],
})
export class UpdatesModule {}
