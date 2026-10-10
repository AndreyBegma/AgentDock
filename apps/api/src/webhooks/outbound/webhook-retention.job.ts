import { WEBHOOK_RETENTION_DAYS } from '@agentdock/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../database/prisma.service';

/** Daily, after the activity retention. */
const RETENTION_CRON = '45 4 * * *';
const JOB_NAME = 'webhooks-retention';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WebhookRetentionResult {
  outbound: number;
  inbound: number;
}

/**
 * D18: deletes `webhook_deliveries` and `inbound_deliveries` older than 30
 * days, daily. Registered with `@nestjs/schedule` so #25's system job list
 * shows it. The inbound replay nonces (D2) need 24 hours, well inside it.
 */
@Injectable()
export class WebhookRetentionJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookRetentionJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const job = CronJob.from({
      cronTime: RETENTION_CRON,
      onTick: () => this.run(),
    });
    this.scheduler.addCronJob(JOB_NAME, job);
    job.start();
  }

  /** One sweep; returns how many deliveries of each direction it deleted. */
  async sweep(now: Date = new Date()): Promise<WebhookRetentionResult> {
    const before = new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * DAY_MS);
    const [outbound, inbound] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.deleteMany({
        where: { createdAt: { lt: before } },
      }),
      this.prisma.inboundDelivery.deleteMany({
        where: { receivedAt: { lt: before } },
      }),
    ]);
    return { outbound: outbound.count, inbound: inbound.count };
  }

  private async run(): Promise<void> {
    try {
      const { outbound, inbound } = await this.sweep();
      if (outbound + inbound > 0)
        this.logger.log(
          `deleted ${outbound} webhook and ${inbound} trigger deliveries older than ${WEBHOOK_RETENTION_DAYS} days`,
        );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`webhook retention failed: ${reason}`);
    }
  }
}
