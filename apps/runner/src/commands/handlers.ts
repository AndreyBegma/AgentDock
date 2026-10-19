import type {
  Capabilities,
  Host,
  TerminalAttachArgs,
  TerminalAttachResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { AssessHandlers } from '../assess';
import type { CaptureHandlers } from '../capture';
import {
  type CardHandlers,
  cardChecks,
  closeCardPr,
  mergeCard,
  retriggerCardCi,
} from '../cards';
import { type Clock, isoNow } from '../clock';
import type { ConfigProfile } from '../config';
import {
  messageOrchestrator,
  orchestratorStatus,
  startOrchestrator,
  stopOrchestrator,
} from '../control/orchestrator';
import { messageSlot, stopSlot } from '../control/slot';
import type { Exec } from '../detect/exec';
import type { DocsHandlers } from '../docs';
import type { HandoffHandlers } from '../handoff';
import type { NormalizeHandlers } from '../normalize';
import type { PlannerHandlers } from '../planner';
import type { Realpath } from '../policy/roots';
import type { PolicyConfig } from '../policy/schema';
import type { ProjectFs } from '../projects/fs';
import { inspectProject, refreshProject } from '../projects/inspect';
import { scanProjectRules } from '../projects/rule-scan';
import type { RepoHandlers } from '../repo';
import type { SessionMessenger } from '../session';
import type { SkillHandlers } from '../skills';
import type { StewardHandlers } from '../steward';
import type { UiProfileHandlers } from '../uiprofile';
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
import { worktreeStatus } from './worktree/status';

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
  /** The runner-local policy as it is now (ADR-0047). */
  policy: () => PolicyConfig;
  /** Resolves a root for the policy; the filesystem's by default. */
  realpath?: Realpath;
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
  /** The planner (spec 172); absent means this runner does not serve plans. */
  planner?: PlannerHandlers;
  /** UI profiles (spec 223); absent means this runner does not build them. */
  uiprofile?: UiProfileHandlers;
  /** Board card workers (#242); absent means this runner does not run them. */
  cards?: CardHandlers;
  /** Card capture (#244); absent means this runner does not extract cards. */
  capture?: CaptureHandlers;
  /** Text normalization (#271); absent means this runner does not translate text. */
  normalize?: NormalizeHandlers;
  /** Card model assessment (#322); absent means this runner does not assess cards. */
  assess?: AssessHandlers;
  /** Docs repositories (#379); absent means this runner does not write to them. */
  docs?: DocsHandlers;
  /** Steward's actions (#447); absent means this runner does not serve them. */
  steward?: StewardHandlers;
  /** Context handoff (#449); absent means this runner does not serve it. */
  handoff?: HandoffHandlers;
  /** A person's messages to sessions (#489); absent means this runner does not serve them. */
  sessionMessage?: SessionMessenger;
  /** The assistant's code commands (#622); absent means this runner does not serve them. */
  repo?: RepoHandlers;
}

const noRepo = (): never => {
  throw new CommandFailure(
    'unsupported',
    'this runner does not serve code questions',
  );
};

const noHandoff = (): never => {
  throw new CommandFailure(
    'unsupported',
    'this runner does not serve Context handoff',
  );
};

const noSteward = (): never => {
  throw new CommandFailure('unsupported', 'this runner does not serve Steward');
};

const noAssess = (): never => {
  throw new CommandFailure('unsupported', 'this runner does not assess cards');
};

const noNormalize = (): never => {
  throw new CommandFailure(
    'unsupported',
    'this runner does not normalize text',
  );
};

const noCards = (): never => {
  throw new CommandFailure(
    'unsupported',
    'this runner does not run board card workers',
  );
};

const noCapture = (): never => {
  throw new CommandFailure(
    'unsupported',
    'this runner does not run card capture',
  );
};

const noSkills = (): never => {
  throw new CommandFailure('unsupported', 'this runner does not serve skills');
};

const noDocs = (): never => {
  throw new CommandFailure(
    'unsupported',
    'this runner does not write to docs repositories',
  );
};

const noPlanner = (): never => {
  throw new CommandFailure('unsupported', 'this runner does not serve plans');
};

const noUiProfile = (): never => {
  throw new CommandFailure(
    'unsupported',
    'this runner does not serve UI profiles',
  );
};

/** One handler per allowlisted command; each later command adds its own here. */
export const createHandlers = (context: HandlerContext): CommandHandlers => {
  const deps = { exec: context.exec, fs: context.fs };
  const control = {
    exec: context.exec,
    clock: context.clock,
    watchedProjects: context.watchedProjects,
    profiles: context.profiles,
    policy: context.policy,
    realpath: context.realpath,
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
    'project.scan_rules': ({ path }) => scanProjectRules(path, deps),
    'session.backfill': (args) =>
      sessionBackfill(args, {
        backfill: context.backfillSessions,
        watchedProjects: context.watchedProjects,
      }),
    'orchestrator.start': (args) => startOrchestrator(args, control),
    'orchestrator.stop': (args) => stopOrchestrator(args, control),
    'orchestrator.status': (args) => orchestratorStatus(args, control),
    'orchestrator.message': (args) => messageOrchestrator(args, control),
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
    'plan.turn': (args) => context.planner?.['plan.turn'](args) ?? noPlanner(),
    'plan.cancel': (args) =>
      context.planner?.['plan.cancel'](args) ?? noPlanner(),
    'plan.close': (args) =>
      context.planner?.['plan.close'](args) ?? noPlanner(),
    'plan.publish_specs': (args) =>
      context.planner?.['plan.publish_specs'](args) ?? noPlanner(),
    'plan.queue_issues': (args) =>
      context.planner?.['plan.queue_issues'](args) ?? noPlanner(),
    'uiprofile.build': (args) =>
      context.uiprofile?.['uiprofile.build'](args) ?? noUiProfile(),
    'uiprofile.fingerprint': (args) =>
      context.uiprofile?.['uiprofile.fingerprint'](args) ?? noUiProfile(),
    'uiprofile.cancel': (args) =>
      context.uiprofile?.['uiprofile.cancel'](args) ?? noUiProfile(),
    'worktree.status': (args) =>
      worktreeStatus(args, {
        exec: context.exec,
        watchedProjects: context.watchedProjects,
      }),
    'card.run': (args) => context.cards?.['card.run'](args) ?? noCards(),
    'card.stop': (args) => context.cards?.['card.stop'](args) ?? noCards(),
    'card.collect': (args) =>
      context.cards?.['card.collect'](args) ?? noCards(),
    'card.close': (args) => context.cards?.['card.close'](args) ?? noCards(),
    'card.merge': (args) =>
      context.cards
        ? mergeCard(args, {
            exec: context.exec,
            watchedProjects: context.watchedProjects,
          })
        : noCards(),
    'card.prClose': (args) =>
      context.cards
        ? closeCardPr(args, {
            exec: context.exec,
            watchedProjects: context.watchedProjects,
          })
        : noCards(),
    'card.checks': (args) =>
      context.cards
        ? cardChecks(args, {
            exec: context.exec,
            watchedProjects: context.watchedProjects,
          })
        : noCards(),
    'card.ciRetrigger': (args) =>
      context.cards
        ? retriggerCardCi(args, {
            exec: context.exec,
            watchedProjects: context.watchedProjects,
          })
        : noCards(),
    'cards.extract': (args) =>
      context.capture?.['cards.extract'](args) ?? noCapture(),
    'text.normalize': (args) =>
      context.normalize?.['text.normalize'](args) ?? noNormalize(),
    'card.assess': (args) =>
      context.assess?.['card.assess'](args) ?? noAssess(),
    'docs.publish_specs': (args) =>
      context.docs?.['docs.publish_specs'](args) ?? noDocs(),
    'docs.pr_state': (args) =>
      context.docs?.['docs.pr_state'](args) ?? noDocs(),
    'session.nudge': (args) =>
      context.steward?.['session.nudge'](args) ?? noSteward(),
    'session.dismiss': (args) =>
      context.steward?.['session.dismiss'](args) ?? noSteward(),
    'card.resume': (args) =>
      context.steward?.['card.resume'](args) ?? noSteward(),
    'digest.compose': (args) =>
      context.steward?.['digest.compose'](args) ?? noSteward(),
    'card.handoff.set': (args) =>
      context.handoff?.['card.handoff.set'](args) ?? noHandoff(),
    'session.message': (args) => {
      if (!context.sessionMessage) {
        throw new CommandFailure(
          'unsupported',
          'this runner does not serve session messages',
        );
      }
      return context.sessionMessage.message(args);
    },
    'repo.search': (args) => context.repo?.['repo.search'](args) ?? noRepo(),
    'repo.read': (args) => context.repo?.['repo.read'](args) ?? noRepo(),
    'code.ask': (args) => context.repo?.['code.ask'](args) ?? noRepo(),
  };
};
