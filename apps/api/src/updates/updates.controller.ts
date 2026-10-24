import type { ProductUpdateView } from '@nautelle/shared';
import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/decorators';
import { ProductReleaseService } from './product-release.service';

/** C-374: the version this install runs and the latest release, for admins. */
@Roles('admin')
@Controller('admin/updates')
export class UpdatesController {
  constructor(private readonly releases: ProductReleaseService) {}

  @Get()
  view(): Promise<ProductUpdateView> {
    return this.releases.view();
  }
}
