import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { ActivityOptions } from '../activity/activity-options';
import { ActivityProjector } from '../activity/activity-projector.service';
import type { BudgetOptions } from '../budgets/budget-options';
import { BudgetSweep } from '../budgets/budget-sweep';
import type { PrismaService } from '../database/prisma.service';
import type { GitHubAppOptions } from '../github-app/github-app-options';
import { GitHubHealthService } from '../github-app/github-health.service';
import { RunsProjector } from '../history/runs-projector.service';
import type { WebhooksOptions } from '../webhooks/common';
import { WebhookDeliveryWorker } from '../webhooks/outbound/webhook-delivery-worker';
import { WebhookDispatcher } from '../webhooks/outbound/webhook-dispatcher';
import type { WorkflowsOptions } from '../workflows/workflows-options';
import { WorkflowsProjector } from '../workflows/workflows-projector.service';
import { SystemJobs } from './system-jobs';

const stub = <T>(): T => ({}) as T;
const options = <T>(value: Partial<T>): T => value as T;

interface Job {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

const jobs = (registry: SchedulerRegistry, on: boolean): Job[] => {
  const activity = options<ActivityOptions>({ loop: on, pollMs: 60_000 });
  const workflows = options<WorkflowsOptions>({ loop: on, pollMs: 60_000 });
  const webhooks = options<WebhooksOptions>({ workerEnabled: on });
  const sweep = new BudgetSweep(
    stub(),
    stub(),
    stub(),
    registry,
    options<BudgetOptions>({ autoStart: on, sweepMs: 60_000 }),
  );
  const activityProjector = new ActivityProjector(
    stub(),
    stub(),
    activity,
    registry,
  );
  const runs = new RunsProjector(stub(), stub(), registry, activity);
  // Its start-up backfill reaches the database once, before the interval.
  const prisma = {
    $executeRaw: async () => 0,
    $transaction: async () => 0,
  } as unknown as PrismaService;
  const workflowsProjector = new WorkflowsProjector(
    prisma,
    registry,
    workflows,
  );
  const dispatcher = new WebhookDispatcher(stub(), registry, webhooks);
  const worker = new WebhookDeliveryWorker(
    stub(),
    stub(),
    stub(),
    stub(),
    registry,
    webhooks,
  );
  const health = new GitHubHealthService(
    stub(),
    stub(),
    stub(),
    registry,
    options<GitHubAppOptions>({ autoStart: on, healthIntervalMs: 60_000 }),
  );
  return [
    sweep,
    activityProjector,
    runs,
    workflowsProjector,
    dispatcher,
    worker,
    health,
  ].map((job) => ({
    start: () => job.onApplicationBootstrap(),
    stop: () =>
      'onModuleDestroy' in job
        ? job.onModuleDestroy()
        : job.onApplicationShutdown(),
  }));
};

describe('periodic jobs in the scheduler registry (#119)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('registers every job as a named interval, and removes it on destroy', async () => {
    const registry = new SchedulerRegistry();
    const all = jobs(registry, true);

    for (const job of all) await job.start();
    expect(registry.getIntervals().sort()).toEqual([
      'activity-projector',
      'budget-sweep',
      'github-health',
      'runs-projector',
      'webhook-delivery-worker',
      'webhook-dispatcher',
      'workflows-projector',
    ]);

    for (const job of all) await job.stop();
    expect(registry.getIntervals()).toEqual([]);
  });

  it('lists the registered names in the admin jobs listing', async () => {
    const registry = new SchedulerRegistry();
    const all = jobs(registry, true);
    for (const job of all) await job.start();

    const listed = await new SystemJobs(registry, stub()).list();
    expect(listed.map((j) => j.name)).toContain('budget-sweep');
    expect(listed.every((j) => j.kind === 'interval')).toBe(true);

    for (const job of all) await job.stop();
  });

  it('registers nothing when the jobs are off (APP_ENV=test)', async () => {
    const registry = new SchedulerRegistry();
    const all = jobs(registry, false);
    for (const job of all) await job.start();
    expect(registry.getIntervals()).toEqual([]);
    for (const job of all) await job.stop();
  });
});
