import { SchedulerRegistry } from '@nestjs/schedule';
import {
  ACTION_REQUEST_EXPIRY_JOB,
  ActionRequestExpiryJob,
} from './action-request-expiry.job';
import type { ActionRequestsService } from './action-requests.service';

const requests = {} as ActionRequestsService;

describe('action request expiry job (spec 201 D18)', () => {
  it('registers a named interval and removes it on destroy', () => {
    const registry = new SchedulerRegistry();
    const job = new ActionRequestExpiryJob(requests, registry, {
      expiryIntervalMs: 60_000,
      autoStart: true,
    });
    job.onApplicationBootstrap();
    expect(registry.getIntervals()).toEqual([ACTION_REQUEST_EXPIRY_JOB]);
    job.onModuleDestroy();
    expect(registry.getIntervals()).toEqual([]);
  });

  it('registers nothing under APP_ENV=test', () => {
    const registry = new SchedulerRegistry();
    new ActionRequestExpiryJob(requests, registry, {
      expiryIntervalMs: 60_000,
      autoStart: false,
    }).onApplicationBootstrap();
    expect(registry.getIntervals()).toEqual([]);
  });
});
