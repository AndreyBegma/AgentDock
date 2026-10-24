import type { PublicUser, SetupStatus } from '@nautelle/shared';
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { requestOrigin } from '../audit/audit-context';
import { setSessionCookies } from '../auth/cookies';
import { Public } from '../auth/decorators';
import { SetupAdminDto } from './dto';
import { SetupService } from './setup.service';

/** C-367: the first-run setup — create the first admin in the browser. */
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  async status(): Promise<SetupStatus> {
    return { needsSetup: await this.setup.needsSetup() };
  }

  // Per IP, as for login: the token is long, but a guesser still gets slowed.
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('admin')
  async admin(
    @Body() dto: SetupAdminDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicUser> {
    const { user, session } = await this.setup.createFirstAdmin(
      dto,
      requestOrigin(request),
    );
    setSessionCookies(response, session);
    return user;
  }
}
