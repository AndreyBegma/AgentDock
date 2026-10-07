import type { Capabilities, Host } from '@agentdock/shared/protocol';
import { type Clock, isoNow } from '../clock';
import type { CommandHandlers } from './dispatcher';

export interface HandlerContext {
  clock: Clock;
  runnerVersion: string;
  host: Host;
  /** Re-detects the machine: `runner.describe` reports the current state. */
  detectCapabilities: () => Promise<Capabilities>;
}

/** The handlers of this item (D9). Each later command adds its own here. */
export const createHandlers = (context: HandlerContext): CommandHandlers => ({
  'runner.ping': () => ({ pong: true, ts: isoNow(context.clock) }),
  'runner.describe': async () => ({
    ...context.host,
    runnerVersion: context.runnerVersion,
    capabilities: await context.detectCapabilities(),
  }),
});
