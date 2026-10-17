import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type AccountThrottled, LoginThrottleAlerts } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { NotificationWriter } from './notification-writer';
import { NotificationsService } from './notifications.service';

const USERS_LINK = '/admin/users';

/**
 * `account.throttled` (C-109): an existing account's failed password checks
 * from one source crossed the threshold — once per account and failure
 * window — to every active admin. Someone may be guessing a password.
 */
@Injectable()
export class AccountThrottleNotifier implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
    private readonly alerts: LoginThrottleAlerts,
  ) {}

  onModuleInit(): void {
    this.alerts.subscribe((event) => this.notify(event));
  }

  async notify(event: AccountThrottled): Promise<void> {
    const source = event.ip ? `from ${event.ip}` : 'from one source';
    const written = await this.prisma.$transaction(async (tx) =>
      this.writer.write(
        tx,
        {
          kind: 'account.throttled',
          projectId: null,
          runnerId: null,
          slot: null,
          issue: null,
          title: `Sign-in attempts throttled for ${event.email}`,
          body: `${event.failures} wrong passwords ${source}. That source now waits longer after every further failure; the account itself is not locked.`,
          link: USERS_LINK,
          eventId: null,
          at: event.at,
          fold: false,
        },
        await this.writer.adminRecipients(tx),
      ),
    );
    await this.notifications.publish(written);
  }
}
