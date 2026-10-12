import type {
  Capabilities,
  Host,
  TerminalAttachArgs,
  TerminalAttachResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { type Clock, isoNow } from '../clock';
import type { ConfigProfile } from '../config';
import {
  orchestratorStatus,
  startOrchestrator,
  stopOrchestrator,
} from '../control/orchestrator';
import { messageSlot, stopSlot } from '../control/slot';
import type { Exec } from '../detect/exec';
import type { ProjectFs } from '../projects/fs';
import { inspectProject, refreshProject } from '../projects/inspect';
import type { SkillHandlers } from '../skills';
import {
  prApprove,
  prRequestChanges,
  prVoidApproval,
} from './approvals/decide';
import { prInspect } from './approvals/inspect';
import type { CommandHandlers } from './dispatcher';
import { CommandFailure } from './failure';
import { type CollectorPollDeps, collectorPoll } from './github/collector-poll';
import { issueCreate } from './queue/issue-create';
import { issuesRefresh } from './queue/issues-refresh';
import {
  type SessionBackfillContext,
  sessionBackfill,
} from './session-backfill';

export interface HandlerContext {
  clock: Clock;
  runnerVersion: string;
  host: Host;
  /** Re-detects the machine: `runner.describe` reports the current state. */
  detectCapabilities: () => Promise<Capabilities>;
  exec: Exec;
  /** The current watch list, as the server last sent it. */
  watchedProjects: () => readonly WatchedProject[];
  /** The runtime profiles of the runner config; the orchestrator starts on one. */
  profiles: () => readonly ConfigProfile[];
  /** Tests inject a spying filesystem; the daemon uses the real one. */
  fs?: ProjectFs;
  /** The session watcher's backfill; absent when sessions are disabled. */
  backfillSessions?: SessionBackfillContext['backfill'];
  /** `collector.poll` (spec 27): the collector registry's `pollNow`. */
  pollCollectors?: CollectorPollDeps['pollNow'];
  /** Interactive attaches (spec 29); absent means this runner cannot attach. */
  terminal?: {
    attach(args: TerminalAttachArgs): Promise<TerminalAttachResult>;
  };
  /** Skills (spec 24); absent means this runner does not serve them. */
  skills?: SkillHandlers;
}

const noSkills = (): never => {
  throw new CommandFailure('unsupported', 'this runner does not serve skills');
};

/** One handler per allowlisted command; each later command adds its own here. */
export const createHandlers = (context: HandlerContext): CommandHandlers => {
  const deps = { exec: context.exec, fs: context.fs };
  const control = {
    exec: context.exec,
    clock: context.clock,
    watchedProjects: context.watchedProjects,
    profiles: context.profiles,
  };
  const approvals = {
    exec: context.exec,
    clock: context.clock,
    watchedProjects: context.watchedProjects,
  };
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
    'session.backfill': (args) =>
      sessionBackfill(args, {
        backfill: context.backfillSessions,
        watchedProjects: context.watchedProjects,
      }),
    'orchestrator.start': (args) => startOrchestrator(args, control),
    'orchestrator.stop': (args) => stopOrchestrator(args, control),
    'orchestrator.status': (args) => orchestratorStatus(args, control),
    'slot.stop': (args) => stopSlot(args, control),
    'slot.message': (args) => messageSlot(args, control),
    'issue.create': (args) =>
      issueCreate(args, {
        exec: context.exec,
        watchedProjects: context.watchedProjects,
      }),
    'issues.refresh': (args) =>
      issuesRefresh(args, { watchedProjects: context.watchedProjects }),
    'collector.poll': (args) =>
      collectorPoll(args, {
        watchedProjects: context.watchedProjects,
        pollNow: context.pollCollectors ?? (async () => []),
      }),
    'pr.inspect': (args) => prInspect(args, approvals),
    'pr.approve': (args) => prApprove(args, approvals),
    'pr.requestChanges': (args) => prRequestChanges(args, approvals),
    'pr.voidApproval': (args) => prVoidApproval(args, approvals),
    'terminal.attach': (args) => {
      if (!context.terminal) {
        throw new CommandFailure(
          'unsupported',
          'this runner does not serve terminal attaches',
        );
      }
      return context.terminal.attach(args);
    },
    'skill.search': (args) =>
      context.skills?.['skill.search'](args) ?? noSkills(),
    'skill.inspect': (args) =>
      context.skills?.['skill.inspect'](args) ?? noSkills(),
    'skill.install': (args) =>
      context.skills?.['skill.install'](args) ?? noSkills(),
    'skill.uninstall': (args) =>
      context.skills?.['skill.uninstall'](args) ?? noSkills(),
    'skill.list': (args) => context.skills?.['skill.list'](args) ?? noSkills(),
    'skill.run': (args) => context.skills?.['skill.run'](args) ?? noSkills(),
    'skill.cancel': (args) =>
      context.skills?.['skill.cancel'](args) ?? noSkills(),
  };
};
