import type {
  AdminRunner,
  AdminRunnerDetail,
  PairingCodeResponse,
  PingResult,
} from '@agentdock/shared';
import { PAIRING_PATH, type PairingResponse } from '@agentdock/shared/protocol';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { CreateRunnerDto, PairRunnerDto, RenameRunnerDto } from './dto';
import { PairingService } from './pairing.service';
import { RunnersService } from './runners.service';

/** D9: admin only, every route. */
@Roles('admin')
@Controller('admin/runners')
export class AdminRunnersController {
  constructor(private readonly runners: RunnersService) {}

  @Post()
  create(
    @Body() dto: CreateRunnerDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<PairingCodeResponse> {
    return this.runners.create(dto.name, admin.id);
  }

  @Get()
  list(): Promise<AdminRunner[]> {
    return this.runners.list();
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<AdminRunnerDetail> {
    return this.runners.detail(id);
  }

  @Patch(':id')
  rename(
    @Param('id') id: string,
    @Body() dto: RenameRunnerDto,
  ): Promise<AdminRunner> {
    return this.runners.rename(id, dto.name);
  }

  @Post(':id/pairing-code')
  @HttpCode(200)
  pairingCode(@Param('id') id: string): Promise<PairingCodeResponse> {
    return this.runners.newPairingCode(id);
  }

  @Post(':id/ping')
  @HttpCode(200)
  ping(@Param('id') id: string): Promise<PingResult> {
    return this.runners.ping(id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Param('id') id: string): Promise<AdminRunner> {
    return this.runners.revoke(id);
  }
}

/** The only public runners route; throttled 10/min per IP (spec "API"). */
@Controller()
export class RunnerPairingController {
  constructor(private readonly pairing: PairingService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post(PAIRING_PATH)
  @HttpCode(200)
  pair(@Body() dto: PairRunnerDto): Promise<PairingResponse> {
    return this.pairing.pair(dto);
  }
}
