import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { SettingsModule } from '../settings/settings.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './guards/csrf.guard';
import { RolesGuard } from './guards/roles.guard';
import { SessionGuard } from './guards/session.guard';
import { LoginThrottle } from './login-throttle';
import { LoginThrottleAlerts } from './login-throttle-alerts';
import { SessionService } from './session.service';

@Module({
  imports: [
    SettingsModule,
    // Applied only where `@UseGuards(ThrottlerGuard)` asks: login, register
    // (spec D8) and the password change (C-109).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    LoginThrottle,
    LoginThrottleAlerts,
    // Global guards run in this order: who you are, then CSRF, then your role.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [SessionService, LoginThrottleAlerts],
})
export class AuthModule {}
