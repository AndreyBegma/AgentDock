import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { legacySessionName } from '@nautelle/shared/legacy-names';
import {
  type OrchestratorMessageArgs,
  type OrchestratorMessageResult,
  type OrchestratorPermissionMode,
  type OrchestratorStartArgs,
  type OrchestratorStartResult,
  type OrchestratorState,
  type OrchestratorStatusResult,
  type OrchestratorTargetArgs,
  orchestratorSessionName,
  type StoppedResult,
} from '@nautelle/shared/protocol';
import { isoNow } from '../clock';
import { ORCHESTRATOR_SKILL } from '../collectors/orchestrator/orchestrator';
import { classifyPane } from '../collectors/tmux/classify';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { resolvePaths } from '../env';
import { removeRawDir } from '../filter/raw-store';
import { resolveFleetProject } from '../fleet/project';
import {
  defaultSelfCommand,
  type TokenSaverLaunch,
  tokenSaverLaunch,
} from '../launch/token-saver';
import {
  permissionModeRefusal,
  policyFailure,
  rootRefusal,
} from '../policy/check';
import { nodeRealpath } from '../policy/roots';
import {
  type LaunchSpec,
  RUN_FILES,
  writeJsonAtomic,
} from '../skills/run/record';
import type { ControlDeps } from './deps';
import { messageFileContent, writeAtomically } from './slot';
import { watchedProject } from './target';
import { TmuxControl } from './tmux';

/** The Claude CLI's `--permission-mode` value for each protocol mode (D3). */
const CLI_PERMISSION_MODE: Record<OrchestratorPermissionMode, string> = {
  auto: 'auto',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  manual: 'default',
};

/**
 * D2's command, one argv element per value: the profile's binary and args,
 * then the remote-control name, model, permission mode and the skill prompt.
 */
export const orchestratorArgv = (
  profile: ConfigProfile,
  session: string,
  args: Pick<OrchestratorStartArgs, 'model' | 'permissionMode' | 'mode'>,
  tokenSaver?: TokenSaverLaunch | null,
): string[] => [
  profile.binary ?? profile.runtime,
  ...profile.args,
  // #445: before a flag, so `--mcp-config <configs...>` takes only its file.
  ...(tokenSaver?.args ?? []),
  '--remote-control',
  session,
  '-n',
  session,
  '--model',
  args.model,
  '--permission-mode',
  CLI_PERMISSION_MODE[args.permissionMode],
  `/${ORCHESTRATOR_SKILL} ${args.mode}`,
];

/** #445: `<state>/nautelle/orchestrator`, beside the spool. */
export const defaultOrchestratorDir = (): string =>
  join(dirname(resolvePaths(process.env).spoolDir), 'orchestrator');

/** #445: the orchestrator session's own dir, for its Token saver files. */
const orchestratorSessionDir = (deps: ControlDeps, session: string): string =>
  join(deps.orchestratorDir ?? defaultOrchestratorDir(), session);

/**
 * #445: the orchestrator session's Token saver — `agentdock` and the scout,
 * its files in a directory of the session's own (it has no run). `null` when
 * off: the session starts as before.
 */
export const orchestratorTokenSaver = async (
  args: Pick<OrchestratorStartArgs, 'tokenSaver' | 'projectId'>,
  deps: ControlDeps,
  profile: ConfigProfile,
  session: string,
): Promise<TokenSaverLaunch | null> => {
  if (!args.tokenSaver?.enabled) return null;
  const dir = orchestratorSessionDir(deps, session);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return tokenSaverLaunch({
    config: args.tokenSaver,
    profile,
    home: deps.home ?? homedir(),
    dir,
    selfCommand: deps.selfCommand ?? defaultSelfCommand(),
    runKind: 'orchestrator',
    projectId: args.projectId,
    runId: null,
    runnerMcp: [],
    scout: true,
  });
};

/**
 * C-123: writes what the orchestrator session launches to `run.json` (0600)
 * in its own dir (0700) — the env never goes on a tmux argv, where the
 * process list shows it — and returns the argv that starts it: `exec-run`.
 */
const orchestratorLaunch = async (
  deps: ControlDeps,
  session: string,
  spec: LaunchSpec,
): Promise<string[]> => {
  const dir = orchestratorSessionDir(deps, session);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(join(dir, RUN_FILES.launch), spec);
  return [...(deps.selfCommand ?? defaultSelfCommand()), 'exec-run', dir];
};

const tmuxOf = (deps: ControlDeps) =>
  new TmuxControl(deps.exec, deps.tmuxServer);

/**
 * The repository's live orchestrator session, or null. ADR-0073: one an older
 * runner started under the `agentdock-orch-` name still counts.
 */
export const findOrchestratorSession = async (
  tmux: Pick<TmuxControl, 'find'>,
  repo: string,
): Promise<string | null> => {
  const name = orchestratorSessionName(repo);
  for (const candidate of [name, legacySessionName(name)]) {
    if (candidate !== null && (await tmux.find(candidate))) return candidate;
  }
  return null;
};

/** The live session of the target's orchestrator, else the name it would get. */
const sessionOf = async (
  deps: ControlDeps,
  args: OrchestratorTargetArgs,
): Promise<string> => {
  const project = watchedProject(args, deps.watchedProjects());
  const fleet = await resolveFleetProject(deps.exec, project);
  return (
    (await findOrchestratorSession(tmuxOf(deps), fleet.repo)) ??
    orchestratorSessionName(fleet.repo)
  );
};

/**
 * `orchestrator.start` (D1, D2). The tmux session name is the lock: a live
 * session answers `already_running`. Done when the session exists, not when
 * the agent is ready (D11).
 */
export const startOrchestrator = async (
  args: OrchestratorStartArgs,
  deps: ControlDeps,
): Promise<OrchestratorStartResult> => {
  // ADR-0047: the dispatcher checked these too; the start path holds them
  // itself, so no other caller can start the orchestrator around them.
  const policy = deps.policy();
  const refused =
    permissionModeRefusal('orchestrator.start', args.permissionMode, policy) ??
    rootRefusal(args.root, policy, deps.realpath ?? nodeRealpath);
  if (refused) throw policyFailure(refused);
  const project = watchedProject(args, deps.watchedProjects());
  const profile = deps.profiles().find((p) => p.id === args.profileId);
  if (!profile) {
    throw new CommandFailure(
      'unknown_profile',
      `no profile ${args.profileId} in the runner config`,
    );
  }
  if (profile.runtime !== 'claude') {
    throw new CommandFailure(
      'unsupported_runtime',
      `the orchestrator runs on claude; ${profile.id} is a ${profile.runtime} profile`,
    );
  }

  const fleet = await resolveFleetProject(deps.exec, project);
  const session = orchestratorSessionName(fleet.repo);
  const tmux = tmuxOf(deps);
  const alreadyRunning = () =>
    new CommandFailure('already_running', `${session} is already running`);
  const running = await findOrchestratorSession(tmux, fleet.repo);
  if (running) {
    throw new CommandFailure(
      'already_running',
      `${running} is already running`,
    );
  }

  const tokenSaver = await orchestratorTokenSaver(args, deps, profile, session);
  const [binary, ...binaryArgs] = orchestratorArgv(
    profile,
    session,
    args,
    tokenSaver,
  );
  const created = await tmux.newSession(
    session,
    project.root,
    await orchestratorLaunch(deps, session, {
      binary: binary ?? profile.runtime,
      args: binaryArgs,
      env: { ...profile.env, ...(tokenSaver?.env ?? {}) },
      cwd: project.root,
      interactive: true,
      label: 'nautelle orchestrator',
    }),
  );
  // Lost a race with a concurrent start: the other one holds the name.
  if (!created.ok && (await tmux.find(session))) throw alreadyRunning();
  if (!created.ok) {
    throw new Error(`tmux new-session ${session} failed: ${created.stderr}`);
  }

  const live = await tmux.find(session);
  if (!live) {
    throw new Error(`${session} exited right after it was started`);
  }
  return {
    session,
    startedAt: live.createdAt ?? isoNow(deps.clock),
  };
};

/** `orchestrator.stop` (D4): kills that one session; slots keep running. */
export const stopOrchestrator = async (
  args: OrchestratorTargetArgs,
  deps: ControlDeps,
): Promise<StoppedResult> => {
  const session = await sessionOf(deps, args);
  const tmux = tmuxOf(deps);
  if (!(await tmux.find(session))) return { stopped: false };
  await tmux.killSession(session);
  // #445 amendment 6: the session's raw outputs go with it; C-123: its env too.
  removeRawDir(orchestratorSessionDir(deps, session));
  await rm(join(orchestratorSessionDir(deps, session), RUN_FILES.launch), {
    force: true,
  });
  return { stopped: true };
};

/** Where `orchestrator.message` files go, under the git common dir (#189). */
export const ORCHESTRATOR_MESSAGE_DIR = join('cs-orchestrator', 'agentdock');

/** The poke typed into the orchestrator's pane; the body is never typed. */
export const orchestratorMessagePrompt = (file: string): string =>
  `Read ${file}: a message from the person via Nautelle`;

/**
 * The repository's common git dir, absolute — inside `.git`, so nothing put
 * there is ever committed. The skill keeps its round board there too.
 */
const gitCommonDir = async (deps: ControlDeps, root: string) => {
  const result = await deps.exec('git', [
    '-C',
    root,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const dir = result?.code === 0 ? result.stdout.trim() : '';
  if (!dir) {
    throw new CommandFailure(
      'not_a_repository',
      `cannot find the git dir of ${root}`,
    );
  }
  return dir;
};

/**
 * `orchestrator.message` (#189), `slot.message`'s twin: the body goes to a
 * file of its own, one per message so none overwrites another, and only a
 * fixed prompt naming it is typed, then submitted in a separate call. Nothing
 * is written when the session is absent, nor when its pane shows a dialog —
 * the typed prompt and its submit would answer the dialog.
 */
export const messageOrchestrator = async (
  args: OrchestratorMessageArgs,
  deps: ControlDeps,
): Promise<OrchestratorMessageResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const fleet = await resolveFleetProject(deps.exec, project);
  const tmux = tmuxOf(deps);
  const session = await findOrchestratorSession(tmux, fleet.repo);
  const text = session ? await tmux.capture(session) : null;
  if (session === null || text === null)
    return { delivered: false, reason: 'absent' };
  if (stateOf(text) === 'prompt') return { delivered: false, reason: 'prompt' };

  const at = isoNow(deps.clock);
  const dir = join(
    await gitCommonDir(deps, project.root),
    ORCHESTRATOR_MESSAGE_DIR,
  );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(
    dir,
    `msg-${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.md`,
  );
  await writeAtomically(
    file,
    messageFileContent({ from: args.from, text: args.body }, at),
  );
  await tmux.sendLiteral(session, orchestratorMessagePrompt(file));
  await tmux.sendSubmit(session);
  return { delivered: true };
};

/** #11's reading of one pane, as a single snapshot. */
const stateOf = (text: string): Exclude<OrchestratorState, 'absent'> => {
  const reading = classifyPane(text);
  if (reading.quota) return 'quota';
  if (reading.kind === 'dialog') return 'prompt';
  return reading.kind === 'busy' ? 'running' : 'idle';
};

/**
 * `orchestrator.status` (D5): presence, the pane classification and the start
 * time. Reads the pane; never types into it.
 */
export const orchestratorStatus = async (
  args: OrchestratorTargetArgs,
  deps: ControlDeps,
): Promise<OrchestratorStatusResult> => {
  const session = await sessionOf(deps, args);
  const tmux = tmuxOf(deps);
  const live = await tmux.find(session);
  const text = live ? await tmux.capture(session) : null;
  // Gone between the listing and the capture: it is absent.
  if (!live || text === null) return { present: false, state: 'absent' };
  return {
    present: true,
    state: stateOf(text),
    session,
    ...(live.createdAt ? { startedAt: live.createdAt } : {}),
  };
};
