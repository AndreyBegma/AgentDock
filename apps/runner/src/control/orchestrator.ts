import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
} from '@agentdock/shared/protocol';
import { isoNow } from '../clock';
import { ORCHESTRATOR_SKILL } from '../collectors/orchestrator/orchestrator';
import { classifyPane } from '../collectors/tmux/classify';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { resolveFleetProject } from '../fleet/project';
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
): string[] => [
  profile.binary ?? profile.runtime,
  ...profile.args,
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

const sessionOf = async (
  deps: ControlDeps,
  args: OrchestratorTargetArgs,
): Promise<string> => {
  const project = watchedProject(args, deps.watchedProjects());
  const fleet = await resolveFleetProject(deps.exec, project);
  return orchestratorSessionName(fleet.repo);
};

const tmuxOf = (deps: ControlDeps) =>
  new TmuxControl(deps.exec, deps.tmuxServer);

/**
 * `orchestrator.start` (D1, D2). The tmux session name is the lock: a live
 * session answers `already_running`. Done when the session exists, not when
 * the agent is ready (D11).
 */
export const startOrchestrator = async (
  args: OrchestratorStartArgs,
  deps: ControlDeps,
): Promise<OrchestratorStartResult> => {
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
  if (await tmux.find(session)) throw alreadyRunning();

  const created = await tmux.newSession(
    session,
    project.root,
    profile.env,
    orchestratorArgv(profile, session, args),
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
  return { stopped: true };
};

/** Where `orchestrator.message` files go, under the git common dir (#189). */
export const ORCHESTRATOR_MESSAGE_DIR = join('cs-orchestrator', 'agentdock');

/** The poke typed into the orchestrator's pane; the body is never typed. */
export const orchestratorMessagePrompt = (file: string): string =>
  `Read ${file}: a message from the person via AgentDock`;

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
  const session = orchestratorSessionName(fleet.repo);
  const tmux = tmuxOf(deps);
  const text = (await tmux.find(session)) ? await tmux.capture(session) : null;
  if (text === null) return { delivered: false, reason: 'absent' };
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
