import { eventsCollector } from './events/events';
import { fleetCollector } from './fleet';
import { issuesCollector } from './issues/issues';
import type { CollectorFactory } from './registry';

export * from './registry';

/**
 * Every collector the daemon runs, one instance per watched project (D16).
 * Each item that adds a collector appends one line here.
 */
export const collectors: CollectorFactory[] = [
  fleetCollector, // spec 11
  eventsCollector(), // spec 16
  issuesCollector(), // spec 19
];
