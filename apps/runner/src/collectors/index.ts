import { fleetCollector } from './fleet';
import type { CollectorFactory } from './registry';

export * from './registry';

/**
 * Every collector the daemon runs, one instance per watched project (D16).
 * Each item that adds a collector appends one line here.
 */
export const collectors: CollectorFactory[] = [
  fleetCollector, // spec 11
];
