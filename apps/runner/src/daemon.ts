import { mkdirSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Capabilities,
  EVENT_SCHEMA_VERSION,
  type Host,
  PROTOCOL_VERSION,
  WATCH_REFUSED_EVENT,
} from '@nautelle/shared/protocol';
import { accessHeaders, accessOf } from './access';
import { adapters, SessionWatcher } from './adapters';
import { resolveIngestSince } from './adapters/ingest-since';
import { AssessExecutor, createAssessHandlers } from './assess';
import { Backoff } from './backoff';
import { CaptureExecutor, createCaptureHandlers } from './capture';
import { CardExecutor, createCardHandlers } from './cards';
import type { Clock } from './clock';
import { CollectorRegistry, collectors } from './collectors';
import { type CommandHandlers, createDispatcher } from './commands/dispatcher';
import { createHandlers } from './commands/handlers';
import { type PairedConfig, updateConfig } from './config';
import {
  type HeartbeatPayload,
  RunnerConnection,
  type SocketFactory,
  type StopReason,
} from './connection';
import { TmuxServerGuard } from './control/tmux-server';
import {
  commandsCapability,
  detectCapabilities,
  extractVersion,
  ptyAvailable,
  readClaudeProfilesAgentdock,
  terminalCapability,
  terminalUnsupported,
} from './detect/capabilities';
import type { Exec } from './detect/exec';
import { claudeConfigDir } from './detect/profiles';
import { createDocsHandlers } from './docs';
import type { Env } from './env';
import { ecoSessionsDir, TranscriptCwds } from './filter/eco';
import { FILTER_ORCHESTRATOR_DIR } from './filter/env';
import { FilterStatsReader } from './filter/stats-reader';
import { GitAuth } from './git-auth';
import {
  createHandoffHandlers,
  HandoffService,
  HandoffStateStore,
  HandoffWriter,
  RunNotes,
} from './handoff';
import { cardAtWorktree } from './handoff/context';
import { readAncestors } from './hooks/ancestors';
import { LocalSocketServer } from './local/server';
import { LocalService } from './local/service';
import { loadSessionTokenSecret, SessionTokens } from './local/session-tokens';
import { HookSessions } from './local/sessions';
import { acquireLock } from './lock';
import { errorMessage, type Logger } from './log';
import { createNormalizeHandlers, NormalizeExecutor } from './normalize';
import {
  loadOtlpToken,
  otlpSettings,
  otlpTokenPath,
  ProjectDirectory,
  startOtlpReceiver,
} from './otlp';
import { PaneStreamer } from './pane';
import {
  createPlannerHandlers,
  PlanTurnExecutor,
  SharedRunSlots,
} from './planner';
import { watchedRootRefusal } from './policy/check';
import { nodeRealpath, type Realpath } from './policy/roots';
import { reportedPolicy } from './policy/schema';
import { PolicyStore } from './policy/store';
import { createPrefixHandlers, PrefixCalls } from './prefix';
import { WatchList } from './projects/watch-list';
import { CodeAsker, createRepoHandlers } from './repo';
import { SessionMessenger } from './session';
import {
  createSkillHandlers,
  RunLogStreamer,
  SkillRunExecutor,
} from './skills';
import { runLogSources } from './skills/run/log';
import { Spool } from './spool';
import {
  StewardActions,
  StewardClassifier,
  StewardDigestWriter,
  StewardObserver,
  type StewardRun,
} from './steward';
import { bunSpawnPty, type SpawnPty, TerminalManager } from './terminal';
import { createUiProfileHandlers, UiProfileBuildExecutor } from './uiprofile';
import { RUNNER_VERSION } from './version';

/**
 * #750 D8: how long after `escalate_card` answers the runner stops the round,
 * so the answer reaches the worker before its session goes.
 */
export const ESCALATED_STOP_DELAY_MS = 3_000;

export interface DaemonOptions {
  config: PairedConfig;
  /** Where `config` was read from; the watch list is cached back into it. */
  configFile: string;
  /**
   * The local socket for the `nautelle` plugin (spec 201 D5);
   * `<state>/nautelle/runner.sock` beside the spool by default, null for none.
   */
  localSocket?: string | null;
  home: string;
  spoolDir: string;
  /** Transcript read positions (spec 12 D5). */
  offsetsFile: string;
  host: Host;
  exec: Exec;
  /** The runner's environment; `process.env` by default. */
  env?: Env;
  clock: Clock;
  log: Logger;
  createSocket?: SocketFactory;
  random?: () => number;
  /** Spawns the PTY of a terminal attach (spec 29); Bun's own by default. */
  spawnPty?: SpawnPty;
  /** Skill runs' directories (spec 24 D7); `<state>/nautelle/runs` beside the spool by default. */
  runsDir?: string;
  /** Plans' worktree records and turns (spec 172); `<state>/nautelle/plans` beside the runs by default. */
  plansDir?: string;
  /** UI profile builds (spec 223); `<state>/nautelle/uiprofile` beside the plans by default. */
  uiprofileDir?: string;
  /** Board card workers (#242); `<state>/nautelle/cards` beside the runs by default. */
  cardsDir?: string;
  /** Card capture's per-extraction directories (#244); `<state>/nautelle/capture` beside the runs by default. */
  captureDir?: string;
  /** Text normalization's per-run directories (#271); `<state>/nautelle/normalize` beside the runs by default. */
  normalizeDir?: string;
  /** Card model assessment's per-run directories (#322); `<state>/nautelle/assess` beside the runs by default. */
  assessDir?: string;
  /** The argv that starts this runner; a skill run's, plan turn's or card's session appends `exec-run <dir>`. */
  selfCommand?: readonly string[];
  /** The skills.sh catalog is fetched with it; the global `fetch` by default. */
  fetch?: typeof fetch;
  /** Aborting it stops the daemon cleanly. */
  signal?: AbortSignal;
  /** How often filter stats are collected (#445); `FILTER_STATS_POLL_MS` by default. */
  filterStatsPollMs?: number;
  /** `/cs-eco`'s sessions (#475); `${XDG_STATE_HOME:-~/.local/state}/cs-eco/sessions` by default. */
  ecoSessionsDir?: string;
  /** Resolves roots for the policy (ADR-0047); the filesystem's by default. */
  realpath?: Realpath;
  /** Called once the connection exists — tests reach it to emit events. */
  onStart?: (connection: RunnerConnection) => void;
}

/** This runner as an argv: the compiled binary, or bun with the entry script. */
export const defaultSelfCommand = (): string[] =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, Bun.main];

/** How often the daemon looks for a policy the CLI changed (ADR-0047). */
export const POLICY_REFRESH_MS = 5_000;

/** Counts tmux sessions; no tmux or no server means zero. */
const countTmuxSessions = async (exec: Exec): Promise<number> => {
  const result = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
  if (!result || result.code !== 0) return 0;
  return result.stdout.split('\n').filter((l) => l.trim().length > 0).length;
};

/** `nautelle-runner run`: lock the spool, detect, connect, run until stopped. */
export const runDaemon = async (
  options: DaemonOptions,
): Promise<StopReason> => {
  const { config, home, clock, log } = options;
  // #329 D1: every git child of the runner goes through this one wrapper.
  const gitAuth = new GitAuth(options.exec);
  // #327: a tmux server the runner starts never lives in the unit's cgroup.
  const tmuxServer = new TmuxServerGuard({
    env: options.env ?? process.env,
    log,
  });
  const exec = tmuxServer.wrap(gitAuth.wrap(options.exec));
  mkdirSync(options.spoolDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(options.spoolDir, 'runner.lock'));
  try {
    const spool = Spool.open({
      dir: options.spoolDir,
      log,
      now: () => new Date(clock.now()),
    });
    log.info('spool opened', { ...spool.stats() });

    // ADR-0047: the runner-local policy, read from the file the CLI writes.
    const policy = new PolicyStore({ configFile: options.configFile, log });
    const realpath = options.realpath ?? nodeRealpath;
    if (policy.current().allowedRoots.length === 0) {
      log.warn(
        'the policy allows no project root: no project is watched. Run `nautelle-runner policy allow-root <dir>`',
      );
    }

    const redetect = async (): Promise<Capabilities> => {
      const [capabilities, github] = await Promise.all([
        detectCapabilities({
          exec,
          home,
          // The receiver's port as bound, not as configured (spec 13).
          config: { profiles: config.profiles, otlp: otlpCapability() },
          otlpToken: otlp?.endpoint?.token,
        }),
        // Each (re)connect re-checks, so a later `gh auth login` takes effect.
        gitAuth.probe(),
      ]);
      const terminal = terminalCapability({
        tmux: capabilities.tmux,
        disabledCommands: config.disabledCommands,
        pty: ptyAvailable(),
      });
      log.info('capabilities detected', {
        claude: capabilities.runtimes.claude?.version ?? null,
        codex: capabilities.runtimes.codex?.version ?? null,
        profiles: capabilities.profiles.length,
        terminal,
        gitAuth: github,
      });
      return {
        ...capabilities,
        terminal,
        gitAuth: { github },
        ...commandsCapability(handlers(), config.disabledCommands),
        policy: reportedPolicy(policy.current()),
      };
    };

    // The handlers need `redetect` (runner.describe), `redetect` needs their
    // keys: built once below, read lazily here.
    let builtHandlers: CommandHandlers | null = null;
    const handlers = (): CommandHandlers => {
      if (!builtHandlers) throw new Error('handlers are not built yet');
      return builtHandlers;
    };

    // Collectors emit through the connection, which exists only below.
    let connection: RunnerConnection | null = null;
    const registry = new CollectorRegistry({
      factories: collectors,
      emit: (event) => connection?.emit(event),
      log,
      context: {
        exec,
        clock,
        fleet: { ...config.fleet, queuePollSeconds: config.queue.pollSeconds },
      },
    });
    const watchList = new WatchList({
      initial: config.projects,
      registry,
      persist: (projects) => updateConfig(options.configFile, { projects }),
      admit: (project) =>
        watchedRootRefusal(project.root, policy.current(), exec, realpath),
      // #691: the web says why a project is not watched, and what to run.
      report: (projects) =>
        connection?.emit({
          v: EVENT_SCHEMA_VERSION,
          ts: new Date(clock.now()).toISOString(),
          type: WATCH_REFUSED_EVENT,
          source: 'runner',
          data: { projects },
        }),
      log,
    });

    // Agent sessions (spec 12): one watcher over every runtime profile. A
    // profile holds the sessions of every directory, so it is not a collector.
    const sessions = config.sessions.enabled
      ? new SessionWatcher({
          adapters,
          profiles: config.profiles,
          home,
          offsetsFile: options.offsetsFile,
          ingestSince: resolveIngestSince(
            config,
            options.configFile,
            clock,
            log,
          ),
          emit: (event) => connection?.emit(event),
          clock,
          log,
        })
      : null;

    // Interactive attaches (spec 29): bytes go out through the connection,
    // which exists only below; `reset` ends every attach when it drops.
    const terminal = new TerminalManager({
      exec,
      clock,
      log,
      watchedProjects: () => watchList.current,
      send: (message) => connection?.sendMessage(message) ?? false,
      spawn: options.spawnPty ?? bunSpawnPty(process.env),
      writeAllowed: () => policy.current().terminal.write,
      // The executor is built below; it exists by the time a command arrives.
      runSession: (projectId, root, runId) =>
        runs.runSession(projectId, root, runId),
      // `hookSessions` is built below too; commands arrive after both exist.
      manualSession: (sessionId) => hookSessions.manualOf(sessionId),
      cardSession: (projectId, root, cardId) =>
        cards.cardSession(projectId, root, cardId),
      unsupported: async () => {
        const tmux = await exec('tmux', ['-V']);
        return terminalUnsupported(
          tmux && tmux.code === 0 ? extractVersion(tmux.stdout) : null,
          ptyAvailable(),
        );
      },
    });

    // Skills (spec 24): runs report through the connection, which exists only
    // below; the executor starts once it does.
    const skillsDeps = {
      exec,
      clock,
      home,
      profiles: () => config.profiles,
      watchedProjects: () => watchList.current,
      fetch: options.fetch ?? fetch,
    };
    // Skill runs and plan turns share the cap (spec 172 "Concurrency").
    const slots = new SharedRunSlots(config.skills.maxConcurrentRuns);
    const selfCommand = options.selfCommand ?? defaultSelfCommand();
    const runs = new SkillRunExecutor({
      deps: skillsDeps,
      runsDir: options.runsDir ?? join(dirname(options.spoolDir), 'runs'),
      selfCommand,
      maxConcurrentRuns: config.skills.maxConcurrentRuns,
      slots,
      maxTimeoutSec: config.skills.maxTimeoutSec,
      keepPatchesLocal: config.skills.keepPatchesLocal,
      emit: (event) => connection?.emit(event),
      log,
      otlp: () => otlp?.endpoint ?? null,
    });
    // #449 D2: haiku writes the notes of dead sessions and interrupted runs.
    const handoffDir = join(dirname(options.spoolDir), 'handoff');
    const handoffWriter = new HandoffWriter({
      dir: join(handoffDir, 'haiku'),
      env: process.env,
      clock,
      log,
      otlp: () => otlp?.endpoint ?? null,
    });
    // Design builds and plan turns (#494): keyed by work, so one store serves both.
    const runNotes = new RunNotes({
      dir: join(handoffDir, 'runs'),
      writer: handoffWriter,
      profiles: () => config.profiles,
      watchedProjects: () => watchList.current,
      emit: (event) => connection?.emit(event),
      clock,
      log,
    });
    const plans = new PlanTurnExecutor({
      deps: skillsDeps,
      plansDir: options.plansDir ?? join(dirname(options.spoolDir), 'plans'),
      selfCommand,
      slots,
      emit: (event) => connection?.emit(event),
      log,
      otlp: () => otlp?.endpoint ?? null,
      attachmentSource: {
        server: config.server,
        insecureServer: config.insecureServer,
        token: config.token,
      },
      runNotes,
    });
    const uiProfiles = new UiProfileBuildExecutor({
      deps: skillsDeps,
      buildsDir:
        options.uiprofileDir ?? join(dirname(options.spoolDir), 'uiprofile'),
      selfCommand,
      slots,
      emit: (event) => connection?.emit(event),
      log,
      otlp: () => otlp?.endpoint ?? null,
      runNotes,
    });
    // #751 B6, B8: the launch prefix's headless calls, beside the spool.
    const prefixCalls = new PrefixCalls({
      deps: skillsDeps,
      policy: () => policy.current(),
      dir: join(dirname(options.spoolDir), 'prefix-calls'),
      env: process.env,
      log,
      otlp: () => otlp?.endpoint ?? null,
    });
    // Context handoff (#449): the card notes, the restart decision and the
    // warm-up. `cards` is built right below; nothing here runs before it.
    const cardsDir =
      options.cardsDir ?? join(dirname(options.spoolDir), 'cards');
    // #113: the capability tokens of the local socket, signed with a secret
    // kept beside the spool, so a card round's token outlives a restart.
    const sessionTokens = new SessionTokens(
      loadSessionTokenSecret(
        join(dirname(options.spoolDir), 'session-token.key'),
      ),
    );
    const handoff: HandoffService = new HandoffService({
      deps: skillsDeps,
      state: new HandoffStateStore((cardId) => join(cardsDir, cardId)),
      record: (cardId) => cards.store.load(cardId),
      records: () => cards.store.all(),
      typeAtPrompt: (session, text) => cards.typeAtPrompt(session, text),
      writer: handoffWriter,
      emit: (event) => connection?.emit(event),
      log,
    });
    // Board card workers (#242): interactive, outside the shared run cap —
    // the API limits running cards per project.
    const cards: CardExecutor = new CardExecutor({
      handoff,
      deps: skillsDeps,
      cardsDir,
      selfCommand,
      attachmentSource: {
        server: config.server,
        insecureServer: config.insecureServer,
        token: config.token,
      },
      emit: (event) => connection?.emit(event),
      log,
      otlp: () => otlp?.endpoint ?? null,
      sessionToken: (binding) => sessionTokens.mint(binding),
      // `steward` is built right below; a poll runs only after `start`.
      onSessionEnded: (record, exitCode) =>
        steward.sessionEnded(record, exitCode),
    });
    // Steward (#447): the runner observes card rounds and skill runs and
    // executes the API's nudge / dismiss / resume. Running skill runs are
    // kept from the executor's phase changes.
    const runningRuns = new Map<string, StewardRun>();
    runs.onChange((record) => {
      if (record.phase === 'running') {
        runningRuns.set(record.runId, {
          runId: record.runId,
          projectId: record.projectId,
          repo: record.repo,
          root: record.root,
          startedAt: record.startedAt,
          streamFile: runs.streamFile(record.runId),
        });
      } else {
        runningRuns.delete(record.runId);
      }
    });
    const steward = new StewardObserver({
      cards: {
        records: () => cards.store.all(),
        capture: (session) => cards.capture(session),
      },
      runs: { running: () => [...runningRuns.values()] },
      watchedProjects: () => watchList.current,
      profiles: () => config.profiles,
      classifier: new StewardClassifier({
        dir: join(dirname(options.spoolDir), 'steward'),
        env: process.env,
        clock,
        log,
        otlp: () => otlp?.endpoint ?? null,
      }),
      emit: (event) => connection?.emit(event),
      clock,
      log,
    });
    const stewardActions = new StewardActions({
      cards: {
        record: (cardId) => cards.store.load(cardId),
        liveSession: (projectId, cardId, runId) =>
          cards.liveSession(projectId, cardId, runId),
        typeAtPrompt: (session, text) => cards.typeAtPrompt(session, text),
        dismissDialog: (session, dialogId) =>
          cards.dismissDialog(session, dialogId),
        resume: (args) => cards.resume(args),
      },
      runs: {
        run: (projectId, runId) => {
          const record = runs.record(runId);
          if (!record || record.projectId !== projectId) return null;
          return {
            session: runs.runSession(projectId, record.root, runId),
            envelope: { repo: record.repo, root: record.root },
          };
        },
      },
      watchedProjects: () => watchList.current,
      emit: (event) => connection?.emit(event),
      clock,
      log,
      onResumed: (subject) => steward.forget(subject),
    });
    // #491: haiku writes the digest prose; the API books it as a `steward` run.
    const stewardDigest = new StewardDigestWriter({
      dir: join(dirname(options.spoolDir), 'steward'),
      env: process.env,
      clock,
      log,
      profiles: () => config.profiles,
      watchedProjects: () => watchList.current,
      otlp: () => otlp?.endpoint ?? null,
    });
    // Card capture (#244): headless, one per project; the API limits the rest.
    const capture = new CaptureExecutor({
      deps: skillsDeps,
      capturesDir:
        options.captureDir ?? join(dirname(options.spoolDir), 'capture'),
      env: process.env,
      emit: (event) => connection?.emit(event),
      log,
      otlp: () => otlp?.endpoint ?? null,
    });
    // Text normalization (#271): headless; the API limits concurrency.
    const normalize = new NormalizeExecutor({
      deps: skillsDeps,
      normalizeDir:
        options.normalizeDir ?? join(dirname(options.spoolDir), 'normalize'),
      env: process.env,
      emit: (event) => connection?.emit(event),
      log,
      otlp: () => otlp?.endpoint ?? null,
    });
    // Card model assessment (#322): headless; the API limits concurrency.
    const assess = new AssessExecutor({
      deps: skillsDeps,
      assessDir: options.assessDir ?? join(dirname(options.spoolDir), 'assess'),
      env: process.env,
      emit: (event) => connection?.emit(event),
      log,
      otlp: () => otlp?.endpoint ?? null,
    });
    const runLog = new RunLogStreamer({
      runs: runLogSources(runs, plans, uiProfiles),
      send: (message) => connection?.sendMessage(message) ?? false,
      clock,
      log,
    });

    builtHandlers = createHandlers({
      clock,
      runnerVersion: RUNNER_VERSION,
      host: options.host,
      detectCapabilities: redetect,
      exec,
      watchedProjects: () => watchList.current,
      pollCollectors: (projectId, targets) =>
        registry.pollNow(projectId, targets),
      profiles: () => config.profiles,
      policy: () => policy.current(),
      realpath,
      backfillSessions: sessions
        ? (scope) => sessions.backfill(scope)
        : undefined,
      terminal,
      skills: createSkillHandlers(skillsDeps, runs),
      planner: createPlannerHandlers({ ...skillsDeps, log }, plans),
      uiprofile: createUiProfileHandlers(skillsDeps, uiProfiles),
      prefix: createPrefixHandlers(prefixCalls),
      cards: createCardHandlers(cards),
      capture: createCaptureHandlers(capture),
      normalize: createNormalizeHandlers(normalize),
      assess: createAssessHandlers(assess),
      docs: createDocsHandlers(skillsDeps),
      steward: { ...stewardActions.handlers(), ...stewardDigest.handlers() },
      handoff: createHandoffHandlers(handoff),
      // #622: the assistant reads the checkout; `code.ask` is read-only.
      repo: createRepoHandlers(
        {
          exec,
          watchedProjects: () => watchList.current,
          policy: () => policy.current(),
        },
        new CodeAsker({
          dir: join(dirname(options.spoolDir), 'code-ask'),
          env: process.env,
          clock,
          log,
          profiles: () => config.profiles,
          watchedProjects: () => watchList.current,
          policy: () => policy.current(),
          otlp: () => otlp?.endpoint ?? null,
        }),
      ),
      sessionMessage: new SessionMessenger({
        cards: {
          record: (cardId) => cards.store.load(cardId),
          liveSession: (projectId, cardId, runId) =>
            cards.liveSession(projectId, cardId, runId),
        },
        exec,
        clock,
        watchedProjects: () => watchList.current,
        log,
      }),
    });
    const dispatch = createDispatcher({
      handlers: builtHandlers,
      disabledCommands: config.disabledCommands,
      policy: () => policy.current(),
      realpath,
      clock,
      log,
    });

    // Live pane (spec 18): frames go out through the connection, which exists
    // only below; with the socket down they are dropped and `reset` ends them.
    const pane = new PaneStreamer({
      exec,
      clock,
      watchedProjects: () => watchList.current,
      send: (message) => connection?.sendMessage(message) ?? false,
      log,
    });

    const heartbeat = async (): Promise<HeartbeatPayload> => {
      const [one, five, fifteen] = loadavg();
      return {
        load: [one, five, fifteen],
        tmuxSessions: await countTmuxSessions(exec),
        collectors: {},
        // #348 D4: sent every time, so a lost heartbeat heals on the next one.
        profiles: readClaudeProfilesAgentdock(
          config.profiles,
          home,
          otlp?.endpoint ?? null,
        ),
      };
    };

    // Away mode (spec 201 D17) comes with every `welcome` and `config`.
    let awayMode = false;
    const hookSessions = new HookSessions();
    const directory = new ProjectDirectory({
      projects: () => watchList.current,
      exec,
    });

    const live = new RunnerConnection({
      server: config.server,
      insecureServer: config.insecureServer,
      token: config.token,
      accessHeaders: accessHeaders(accessOf(config)),
      spool,
      clock,
      backoff: new Backoff({ random: options.random }),
      log,
      // Each (re)connect reports the machine as it is now.
      hello: async () => ({
        runnerVersion: RUNNER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        ...options.host,
        capabilities: await redetect(),
      }),
      heartbeat,
      dispatch,
      pane,
      terminal,
      runLog,
      onConfig: (server) => {
        awayMode = server.awayMode === true;
        // Sessions follow the admitted list only (ADR-0047).
        watchList
          .apply(server.projects)
          .then(() => sessions?.setProjects(watchList.current))
          .catch((error) => {
            log.error('cannot apply the watch list', {
              error: errorMessage(error),
            });
          });
      },
      createSocket: options.createSocket,
    });
    connection = live;

    // OTLP receiver (spec 13 D11): sessions with telemetry on report each
    // request live, into the spool like every other event. Started before
    // `hello`, which reports its port.
    const otlp = startOtlpReceiver({
      settings: otlpSettings(config.otlp),
      // L-30: kept beside the spool, so `setup claude` writes the same one.
      token: loadOtlpToken(otlpTokenPath(dirname(options.spoolDir))),
      emit: (event) => live.emit(event),
      projects: () => watchList.current,
      sessionProject: (id) => hookSessions.projectOf(id, watchList.current),
      directory,
      exec,
      clock,
      log,
    });
    const otlpCapability = (): Capabilities['otlp'] =>
      otlp?.port ? { grpc: null, http: otlp.port } : null;

    // Token saver (#445 amendment 5): the `filter` processes of every launch
    // write rows into their run dir; they go out as `filter.stats` events.
    // `/cs-eco` sessions the runner did not launch keep theirs in the
    // plugin's state dir, and count for the watched root of their cwd (#475).
    const stateDir = dirname(options.spoolDir);
    const transcriptCwds = new TranscriptCwds({
      dirs: () => [
        join(home, '.claude', 'projects'),
        ...config.profiles
          .filter((p) => p.runtime === 'claude')
          .map((p) => join(claudeConfigDir(p, home), 'projects')),
      ],
      now: () => clock.now(),
    });
    const filterStats = new FilterStatsReader({
      roots: () => [
        options.runsDir ?? join(stateDir, 'runs'),
        options.plansDir ?? join(stateDir, 'plans'),
        options.uiprofileDir ?? join(stateDir, 'uiprofile'),
        options.cardsDir ?? join(stateDir, 'cards'),
        options.captureDir ?? join(stateDir, 'capture'),
        options.normalizeDir ?? join(stateDir, 'normalize'),
        options.assessDir ?? join(stateDir, 'assess'),
        join(stateDir, FILTER_ORCHESTRATOR_DIR),
      ],
      eco: {
        dir:
          options.ecoSessionsDir ??
          ecoSessionsDir(options.env ?? process.env, home),
        projects: () => watchList.current,
        sessionCwd: (id) => hookSessions.cwdOf(id) ?? transcriptCwds.cwdOf(id),
      },
      resolve: (ids) => directory.resolve(ids),
      emit: (event) => {
        live.emit(event);
      },
      log,
      now: () => new Date(clock.now()),
      pollMs: options.filterStatsPollMs,
    });

    // The plugin's hook and MCP processes (spec 201 D5): bound after
    // `runner.lock` is held, so a socket file left there is a dead daemon's.
    const localService = new LocalService({
      projects: () => watchList.current,
      awayMode: () => awayMode,
      online: () => live.isLive,
      emit: (event) => {
        // #447 D6: a hook event is the session's activity, for silence.
        steward.hookSeen(event);
        // #449 D8, D9: a stop checks the round's note; a first edit ends its warm-up.
        handoff.hookSeen(event);
        live.emit(event);
      },
      relay: (request) => live.request(request),
      envelope: async (projectId) =>
        (await directory.resolve([projectId])).get(projectId),
      sessions: hookSessions,
      tokens: sessionTokens,
      // #113: the daemon reads a peer's ancestors itself, never the hook's word.
      ancestorsOf: (pid) =>
        readAncestors(pid, { os: process.platform, exec: options.exec }),
      alive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      launchedSession: (sessionId) =>
        cards.store
          .all()
          .some(
            (r) =>
              r.sessionId === sessionId &&
              (r.phase === 'starting' || r.phase === 'running'),
          ) || cards.reviewSession(sessionId),
      // #482: a round's session is known from its record after a restart.
      liveRound: (cwd) =>
        cardAtWorktree(
          cards.store
            .all()
            .filter((r) => r.phase === 'starting' || r.phase === 'running'),
          cwd,
        ),
      // #750 D8: after the tool's answer has reached the worker.
      stopRoundSoon: (round) => {
        clock.setTimeout(() => {
          cards.stopRound(round).catch((error) => {
            log.warn('cards: stopping an escalated round failed', {
              cardId: round.cardId,
              runId: round.runId,
              error: errorMessage(error),
            });
          });
        }, ESCALATED_STOP_DELAY_MS);
      },
      now: () => new Date(clock.now()).toISOString(),
      log,
    });
    const socketPath =
      options.localSocket === undefined
        ? join(dirname(options.spoolDir), 'runner.sock')
        : options.localSocket;
    let local: LocalSocketServer | null = null;
    if (socketPath) {
      const server = new LocalSocketServer({
        path: socketPath,
        handle: (op, args, caller) => localService.handle(op, args, caller),
        log,
      });
      try {
        server.start();
        local = server;
        log.info('local: socket listening', { path: socketPath });
      } catch (error) {
        log.error('local: cannot open the socket', {
          path: socketPath,
          error: errorMessage(error),
        });
      }
    }

    const onAbort = () => live.stop();
    if (options.signal?.aborted) live.stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Before any resumed run or card can fetch or push.
    await gitAuth.probe();
    await watchList.start();
    // Runs a previous runner left are picked up; their events go to the spool.
    await runs.start().catch((error) => {
      log.error('skills: cannot resume runs', { error: errorMessage(error) });
    });
    await plans.start().catch((error) => {
      log.error('planner: cannot resume turns', {
        error: errorMessage(error),
      });
    });
    await uiProfiles.start().catch((error) => {
      log.error('uiprofile: cannot resume builds', {
        error: errorMessage(error),
      });
    });
    await cards.start().catch((error) => {
      log.error('cards: cannot resume watching workers', {
        error: errorMessage(error),
      });
    });
    // Not awaited: a first scan of a large profile must not delay connecting.
    sessions?.start(watchList.current).catch((error) => {
      log.error('sessions: cannot start', { error: errorMessage(error) });
    });
    steward.start();
    // A policy the CLI changed takes effect without a restart.
    let policySeen = policy.version;
    const cancelPolicyRefresh = clock.setInterval(() => {
      if (policy.version === policySeen) return;
      policySeen = policy.version;
      watchList
        .reapply()
        .then(() => sessions?.setProjects(watchList.current))
        .catch((error) => {
          log.error('cannot re-apply the watch list', {
            error: errorMessage(error),
          });
        });
    }, POLICY_REFRESH_MS);
    live.start();
    filterStats.start();
    options.onStart?.(live);
    const reason = await live.done;
    options.signal?.removeEventListener('abort', onAbort);
    cancelPolicyRefresh();
    filterStats.stop();
    // What the last commands wrote goes to the spool, sent on the next start.
    await filterStats.poll();
    pane.stop();
    runLog.stop();
    // Sessions run on in tmux; the next start resumes watching them.
    runs.stop();
    plans.stop();
    uiProfiles.stop();
    prefixCalls.stop();
    cards.stop();
    steward.stop();
    capture.stop();
    normalize.stop();
    assess.stop();
    terminal.stop();
    await registry.stop();
    await sessions?.stop();
    await otlp?.stop();
    local?.stop();
    return reason;
  } finally {
    release();
  }
};
