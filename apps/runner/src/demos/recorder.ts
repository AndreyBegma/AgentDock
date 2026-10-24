import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ATTACHMENT_VIDEO_MAX_BYTES } from '@nautelle/shared';
import {
  type CardDemoArgs,
  type CardDemoResult,
  demoStatusDataSchema,
  type UnsequencedEvent,
  type WatchedProject,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import { cardWorktreePath } from '../cards/launch';
import { type Clock, isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import { definedOnly, type Exec } from '../detect/exec';
import type { Env } from '../env';
import { resolveFleetProject } from '../fleet/project';
import { errorMessage, type Logger } from '../log';
import {
  DemoApiError,
  type DemoApiSource,
  fetchDemoEnv,
  type UploadOptions,
  uploadDemoVideo,
} from './api';
import { DEMOFLOW_FEATURES, DEMOFLOW_VERSION, demoflowCommand } from './pin';
import {
  createDemoflowSpawn,
  type DemoflowSpawn,
  freePort,
  portInUse,
} from './process';
import { boundedReason, type DemoflowProvisioner } from './provision';
import {
  failureReason,
  maskedReason,
  parseSummary,
  renderedVideo,
} from './report';

/** ADR-0090: a recording is killed, app and all, after this long. */
export const DEMO_RUN_TIMEOUT_MS = 10 * 60_000;
/** Demos waiting behind the one recording; one more is `busy`. */
export const DEMO_QUEUE_MAX = 16;
/** DemoFlow's project config, at the root of the repository. */
export const DEMOFLOW_CONFIG_FILE = 'demoflow.config.json';

/** What the runner reads of `demoflow.config.json`; DemoFlow checks the rest. */
const demoflowConfigSchema = z.object({
  baseUrl: z.string().min(1),
  devCommand: z
    .object({ command: z.string().min(1), readyUrl: z.string().min(1) })
    .optional(),
});

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** How a recording ended; `gone`: the API no longer has it queued or recording. */
type Outcome =
  | { status: 'ready' }
  | { status: 'failed' | 'skipped'; reason: string }
  | { status: 'gone' };

const failed = (reason: string): Outcome => ({ status: 'failed', reason });

export interface PortPlan {
  port: number;
  /** Extra `demoflow run` arguments that move the app to `port`. */
  args: string[];
}

export interface PortProbes {
  portInUse: (port: number) => Promise<boolean>;
  freePort: () => Promise<number>;
}

/**
 * The port the card's app runs on. With port templating (a later DemoFlow)
 * the runner picks a free one and DemoFlow starts a fresh app there. DemoFlow
 * 0.4.0 starts the app on the port its `readyUrl` names and reuses whatever
 * already answers there, so the runner refuses when that port is taken.
 */
export const planPort = async (
  config: z.infer<typeof demoflowConfigSchema>,
  features: { portTemplating: boolean },
  probes: PortProbes,
): Promise<PortPlan | string> => {
  if (!config.devCommand) {
    return `${DEMOFLOW_CONFIG_FILE} has no devCommand: the runner records only an app DemoFlow starts itself`;
  }
  let ready: URL;
  try {
    ready = new URL(config.devCommand.readyUrl);
  } catch {
    return `the readyUrl of ${DEMOFLOW_CONFIG_FILE} is not a URL`;
  }
  if (!LOOPBACK.has(ready.hostname)) {
    return `the readyUrl of ${DEMOFLOW_CONFIG_FILE} is not on this machine (${ready.hostname})`;
  }
  if (features.portTemplating) {
    const port = await probes.freePort();
    return {
      port,
      args: ['--base-url', `http://127.0.0.1:${port}`, '--fresh-app'],
    };
  }
  const port = Number(ready.port || (ready.protocol === 'https:' ? 443 : 80));
  if (await probes.portInUse(port)) {
    return `port ${port} (the readyUrl of ${DEMOFLOW_CONFIG_FILE}) is already in use; DemoFlow ${DEMOFLOW_VERSION} would record what runs there instead of this card's app`;
  }
  return { port, args: [] };
};

/** `path` is `dir` or inside it, both real paths. */
const within = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}${sep}`);

export interface DemoRecorderDeps {
  exec: Exec;
  log: Logger;
  clock: Clock;
  emit: (event: UnsequencedEvent) => void;
  watchedProjects: () => readonly WatchedProject[];
  provisioner: Pick<DemoflowProvisioner, 'ensure'>;
  api: DemoApiSource;
  /** The runner's environment; a demo's process gets it with `PORT` and the secrets. */
  env: Env;
  /** Where each recording's DemoFlow output lives until it is uploaded. */
  workDir: string;
  spawn?: DemoflowSpawn;
  probes?: PortProbes;
  features?: { portTemplating: boolean };
  timeoutMs?: number;
  upload?: UploadOptions;
}

interface Job {
  args: CardDemoArgs;
  project: WatchedProject;
}

/**
 * C-369 (ADR-0090): `card.demo`. The command validates and queues; the
 * recording runs after it answers and reports through `demo.status` — and,
 * on success, through the upload, which makes the demo ready. One demo
 * records at a time on a runner; the others wait in order.
 *
 * Secrets: read from the API per recording, kept in memory, handed to the
 * `demoflow` process environment only — never in its arguments, a file, a
 * log line or an event. Every reason is masked against them and redacted.
 */
export class DemoRecorder {
  private readonly queue: Job[] = [];
  private current: Job | null = null;
  private readonly spawn: DemoflowSpawn;
  private readonly probes: PortProbes;

  constructor(private readonly deps: DemoRecorderDeps) {
    this.spawn = deps.spawn ?? createDemoflowSpawn(deps.exec);
    this.probes = deps.probes ?? { portInUse, freePort };
  }

  /** `card.demo`: refused at once when the project is not watched. */
  command(args: CardDemoArgs): CardDemoResult {
    const project = watchedProject(
      { projectId: args.projectId, root: args.worktree.root },
      this.deps.watchedProjects(),
    );
    if (this.current?.args.demoId === args.demoId) {
      return { status: 'recording' };
    }
    if (this.queue.some((job) => job.args.demoId === args.demoId)) {
      return { status: 'queued' };
    }
    if (this.queue.length >= DEMO_QUEUE_MAX) {
      throw new CommandFailure(
        'busy',
        `${DEMO_QUEUE_MAX} demos are already waiting on this runner`,
      );
    }
    this.queue.push({ args, project });
    const status = this.current === null ? 'recording' : 'queued';
    this.drain();
    return { status };
  }

  /** Resolves once nothing records and nothing waits; for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.current !== null || this.queue.length > 0) {
      await new Promise((done) => setTimeout(done, 10));
    }
  }

  private drain(): void {
    if (this.current !== null) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    void this.run(next).finally(() => {
      this.current = null;
      this.drain();
    });
  }

  private async run(job: Job): Promise<void> {
    const { args } = job;
    const fleet = await resolveFleetProject(this.deps.exec, job.project);
    const report = (
      status: 'recording' | 'failed' | 'skipped',
      extra: { reason?: string; scenarioPath?: string },
    ) => {
      const at = isoNow(this.deps.clock);
      this.deps.emit({
        v: 1,
        ts: at,
        type: 'demo.status',
        source: 'runner',
        project: { repo: fleet.repo, root: job.project.root },
        data: demoStatusDataSchema.parse({
          cardId: args.cardId,
          projectId: args.projectId,
          demoId: args.demoId,
          status,
          at,
          ...extra,
        }),
      });
    };
    let found = false;
    let outcome: Outcome;
    try {
      outcome = await this.record(job, (scenarioPath) => {
        found = true;
        report('recording', { scenarioPath });
      });
    } catch (error) {
      outcome = failed(errorMessage(error));
    }
    const fields = { card: args.card, demoId: args.demoId };
    if (outcome.status === 'failed' || outcome.status === 'skipped') {
      const reason = boundedReason(outcome.reason);
      report(outcome.status, {
        reason,
        ...(found ? { scenarioPath: args.scenario } : {}),
      });
      this.deps.log.info(`demo ${outcome.status}`, { ...fields, reason });
    } else if (outcome.status === 'gone') {
      this.deps.log.info('demo is no longer active; dropped', fields);
    } else {
      this.deps.log.info('demo uploaded', fields);
    }
  }

  private async record(
    job: Job,
    started: (scenarioPath: string) => void,
  ): Promise<Outcome> {
    const { args } = job;
    const worktree = cardWorktreePath(
      args.worktree.root,
      args.worktree.shortId,
    );
    if (!existsSync(worktree) || !lstatSync(worktree).isDirectory()) {
      return failed(`the card's worktree ${worktree} does not exist`);
    }
    const top = realpathSync(worktree);
    const scenario = join(worktree, args.scenario);
    if (!existsSync(scenario)) {
      return {
        status: 'skipped',
        reason: `the card has no scenario at ${args.scenario}`,
      };
    }
    const scenarioReal = realpathSync(scenario);
    if (!within(scenarioReal, top) || !statSync(scenarioReal).isFile()) {
      return failed(`${args.scenario} is not a file in the card's worktree`);
    }

    let config: z.infer<typeof demoflowConfigSchema>;
    try {
      config = demoflowConfigSchema.parse(
        JSON.parse(readFileSync(join(top, DEMOFLOW_CONFIG_FILE), 'utf8')),
      );
    } catch {
      return failed(
        `the repository has no valid ${DEMOFLOW_CONFIG_FILE} with a baseUrl`,
      );
    }
    const plan = await planPort(
      config,
      this.deps.features ?? DEMOFLOW_FEATURES,
      this.probes,
    );
    if (typeof plan === 'string') return failed(plan);

    started(args.scenario);
    const demoflow = await this.deps.provisioner.ensure();
    if (!demoflow.ready) {
      return failed(`DemoFlow is not ready: ${demoflow.reason ?? 'unknown'}`);
    }

    let secrets: Record<string, string>;
    try {
      secrets = await fetchDemoEnv(this.deps.api, args.card, args.demoId, [
        ...args.env,
      ]);
    } catch (error) {
      if (error instanceof DemoApiError && error.notActive) {
        return { status: 'gone' };
      }
      return failed(errorMessage(error));
    }
    const values = Object.values(secrets);

    mkdirSync(this.deps.workDir, { recursive: true, mode: 0o700 });
    const out = mkdtempSync(join(this.deps.workDir, 'demo-'));
    try {
      const run = demoflowCommand(
        'run',
        relative(top, scenarioReal),
        '--json',
        '--format',
        'mp4',
        '--out',
        out,
        ...plan.args,
      );
      const timeoutMs = this.deps.timeoutMs ?? DEMO_RUN_TIMEOUT_MS;
      const exit = await this.spawn(run.binary, run.args, {
        cwd: top,
        env: {
          ...definedOnly(this.deps.env),
          PORT: String(plan.port),
          ...secrets,
        },
        timeoutMs,
      });
      if (exit.timedOut) {
        return failed(
          `the recording passed the ${Math.round(timeoutMs / 60_000)}-minute limit and was stopped`,
        );
      }
      const summary = parseSummary(exit.stdout);
      if (summary === null) {
        return failed(
          maskedReason(
            `DemoFlow exited with code ${exit.code ?? 'none'} and no summary: ${exit.stderr.trim().slice(-300)}`,
            values,
          ),
        );
      }
      if (summary.status === 'failed' || summary.status === 'running') {
        return failed(failureReason(summary, values));
      }
      const video = renderedVideo(summary, out);
      if (video === null) return failed('DemoFlow rendered no MP4');
      return await this.upload(job, video, realpathSync(out));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  private async upload(
    job: Job,
    video: { path: string; durationMs: number | null },
    out: string,
  ): Promise<Outcome> {
    let real: string;
    try {
      real = realpathSync(video.path);
    } catch {
      return failed('the MP4 DemoFlow reported is missing');
    }
    if (!within(real, out) || !statSync(real).isFile()) {
      return failed('the MP4 DemoFlow reported is outside its output');
    }
    const size = statSync(real).size;
    if (size === 0) return failed('DemoFlow rendered an empty MP4');
    if (size > ATTACHMENT_VIDEO_MAX_BYTES) {
      return failed(
        `the MP4 is ${size} bytes, over the ${ATTACHMENT_VIDEO_MAX_BYTES}-byte limit`,
      );
    }
    const bytes = new Uint8Array(readFileSync(real));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      await uploadDemoVideo(
        this.deps.api,
        job.args.card,
        job.args.demoId,
        { bytes, sha256, durationMs: video.durationMs },
        this.deps.upload,
      );
      return { status: 'ready' };
    } catch (error) {
      if (error instanceof DemoApiError && error.notActive) {
        return { status: 'gone' };
      }
      return failed(errorMessage(error));
    }
  }
}
