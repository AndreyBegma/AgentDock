import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { CryptoModule } from '../common/crypto';
import { SettingsModule } from '../settings/settings.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './guards/csrf.guard';
import { RolesGuard } from './guards/roles.guard';
import { SessionGuard } from './guards/session.guard';
import { LoginThrottle } from './login-throttle';
import { LoginThrottleAlerts } from './login-throttle-alerts';
import { SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';

@Module({
  imports: [
    SettingsModule,
    CryptoModule,
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
    TwoFactorService,
    // Global guards run in this order: who you are, then CSRF, then your role.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [SessionService, LoginThrottleAlerts, TwoFactorService],
})
export class AuthModule {}
