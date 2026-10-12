import { SchedulerRegistry } from '@nestjs/schedule';
import { NotificationMatcher } from './notification-matcher';
import type { NotificationOptions } from './notification-options';
import { defaultNotificationOptions } from './notification-options';
import { RunnerWatcher } from './runner-watcher';

const options = (autoStart: boolean): NotificationOptions => ({
  ...defaultNotificationOptions,
  autoStart,
});

const stub = <T>(): T => ({}) as T;

describe('notification periodic jobs', () => {
  it('registers the matcher and the watcher as named intervals, and removes them on destroy', () => {
    const registry = new SchedulerRegistry();
    const matcher = new NotificationMatcher(
      stub(),
      stub(),
      stub(),
      registry,
      options(true),
    );
    const watcher = new RunnerWatcher(
      stub(),
      stub(),
      stub(),
      stub(),
      registry,
      options(true),
    );

    matcher.onApplicationBootstrap();
    watcher.onApplicationBootstrap();
    expect(registry.getIntervals().sort()).toEqual([
      'notification-matcher',
      'runner-watcher',
    ]);

    matcher.onModuleDestroy();
    watcher.onModuleDestroy();
    expect(registry.getIntervals()).toEqual([]);
  });

  it('registers nothing when autoStart is off (APP_ENV=test)', () => {
    const registry = new SchedulerRegistry();
    new NotificationMatcher(
      stub(),
      stub(),
      stub(),
      registry,
      options(false),
    ).onApplicationBootstrap();
    new RunnerWatcher(
      stub(),
      stub(),
      stub(),
      stub(),
      registry,
      options(false),
    ).onApplicationBootstrap();
    expect(registry.getIntervals()).toEqual([]);
  });
});
