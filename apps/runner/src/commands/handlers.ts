import type {
  Capabilities,
  Host,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { type Clock, isoNow } from '../clock';
import type { Exec } from '../detect/exec';
import type { ProjectFs } from '../projects/fs';
import { inspectProject, refreshProject } from '../projects/inspect';
import type { CommandHandlers } from './dispatcher';

export interface HandlerContext {
  clock: Clock;
  runnerVersion: string;
  host: Host;
  /** Re-detects the machine: `runner.describe` reports the current state. */
  detectCapabilities: () => Promise<Capabilities>;
  exec: Exec;
  /** The current watch list, as the server last sent it. */
  watchedProjects: () => readonly WatchedProject[];
  /** Tests inject a spying filesystem; the daemon uses the real one. */
  fs?: ProjectFs;
}

/** One handler per allowlisted command; each later command adds its own here. */
export const createHandlers = (context: HandlerContext): CommandHandlers => {
  const deps = { exec: context.exec, fs: context.fs };
  return {
    'runner.ping': () => ({ pong: true, ts: isoNow(context.clock) }),
    'runner.describe': async () => ({
      ...context.host,
      runnerVersion: context.runnerVersion,
      capabilities: await context.detectCapabilities(),
    }),
    'project.inspect': ({ path }) => inspectProject(path, deps),
    'project.refresh': (args) =>
      refreshProject(args, context.watchedProjects(), deps),
  };
};
