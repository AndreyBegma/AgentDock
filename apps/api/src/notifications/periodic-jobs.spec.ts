import { SchedulerRegistry } from '@nestjs/schedule';
import { BlockedCheckpointSweep } from './blocked-checkpoint-sweep';
import { NotificationMatcher } from './notification-matcher';
import type { NotificationOptions } from './notification-options';
import { defaultNotificationOptions } from './notification-options';
import { RunnerWatcher } from './runner-watcher';

const options = (autoStart: boolean): NotificationOptions => ({
  ...defaultNotificationOptions,
  autoStart,
});

const stub = <T>(): T => ({}) as T;

const jobs = (registry: SchedulerRegistry, autoStart: boolean) => [
  new NotificationMatcher(stub(), stub(), stub(), registry, options(autoStart)),
  new RunnerWatcher(
    stub(),
    stub(),
    stub(),
    stub(),
    registry,
    options(autoStart),
  ),
  new BlockedCheckpointSweep(
    stub(),
    stub(),
    stub(),
    registry,
    options(autoStart),
  ),
];

describe('notification periodic jobs', () => {
  it('registers the matcher, the watcher and the sweep as named intervals, and removes them on destroy', () => {
    const registry = new SchedulerRegistry();
    const all = jobs(registry, true);

    for (const job of all) job.onApplicationBootstrap();
    expect(registry.getIntervals().sort()).toEqual([
      'blocked-checkpoint-sweep',
      'notification-matcher',
      'runner-watcher',
    ]);

    for (const job of all) job.onModuleDestroy();
    expect(registry.getIntervals()).toEqual([]);
  });

  it('registers nothing when autoStart is off (APP_ENV=test)', () => {
    const registry = new SchedulerRegistry();
    for (const job of jobs(registry, false)) job.onApplicationBootstrap();
    expect(registry.getIntervals()).toEqual([]);
  });
});
