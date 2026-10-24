import { DEMO_REASON_MAX } from '@nautelle/shared';
import type { DemoflowStatus } from '@nautelle/shared/protocol';
import type { Exec } from '../detect/exec';
import { errorMessage, type Logger } from '../log';
import { redactText } from '../pane/redact';
import { DEMOFLOW_NODE_MAJOR, DEMOFLOW_VERSION, demoflowCommand } from './pin';

/** `npx` downloads DemoFlow and its dependencies on the first call. */
export const DEMOFLOW_FETCH_TIMEOUT_MS = 5 * 60_000;
/** `demoflow setup` downloads Chromium. */
export const DEMOFLOW_SETUP_TIMEOUT_MS = 15 * 60_000;

/** The last characters of a failed step's output a reason keeps. */
const OUTPUT_TAIL = 200;

/** A reason as the capability and `demo.status` carry it: redacted, bounded. */
export const boundedReason = (text: string): string => {
  const clean = redactText(text).replace(/\s+/g, ' ').trim();
  const reason = clean.length > 0 ? clean : 'no reason given';
  return reason.length > DEMO_REASON_MAX
    ? `${reason.slice(0, DEMO_REASON_MAX - 1)}…`
    : reason;
};

const tail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL
    ? `…${trimmed.slice(-OUTPUT_TAIL)}`
    : trimmed;
};

const nodeMajor = (version: string): number | null => {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
};

export interface DemoflowProvisionerDeps {
  exec: Exec;
  log: Logger;
}

/**
 * C-369: makes the pinned DemoFlow runnable on this machine — Node new
 * enough, the package fetched by `npx`, Chromium installed by
 * `demoflow setup` — and reports how that went as the `demoflow`
 * capability. It provisions on the first demo, not at start: a runner that
 * never records never downloads a browser. A failure is not kept: the next
 * demo tries again, so a fixed machine needs no restart.
 */
export class DemoflowProvisioner {
  private current: DemoflowStatus = {
    version: DEMOFLOW_VERSION,
    ready: false,
    reason: 'DemoFlow is set up on the first demo',
  };
  private inFlight: Promise<DemoflowStatus> | null = null;

  constructor(private readonly deps: DemoflowProvisionerDeps) {}

  /** The capability as it is now. */
  status(): DemoflowStatus {
    return this.current;
  }

  /** Provisions once at a time; a ready DemoFlow is not checked again. */
  ensure(): Promise<DemoflowStatus> {
    if (this.current.ready) return Promise.resolve(this.current);
    this.inFlight ??= this.provision()
      .catch(
        (error): DemoflowStatus => ({
          version: DEMOFLOW_VERSION,
          ready: false,
          reason: boundedReason(errorMessage(error)),
        }),
      )
      .then((status) => {
        this.current = status;
        this.inFlight = null;
        if (status.ready) {
          this.deps.log.info('DemoFlow is ready', { version: status.version });
        } else {
          this.deps.log.warn('DemoFlow is not ready', {
            reason: status.reason,
          });
        }
        return status;
      });
    return this.inFlight;
  }

  private async provision(): Promise<DemoflowStatus> {
    const notReady = (reason: string): DemoflowStatus => ({
      version: DEMOFLOW_VERSION,
      ready: false,
      reason: boundedReason(reason),
    });
    const { exec } = this.deps;

    const node = await exec('node', ['--version']);
    const major = node?.code === 0 ? nodeMajor(node.stdout) : null;
    if (major === null) return notReady('Node.js is not on the PATH');
    if (major < DEMOFLOW_NODE_MAJOR) {
      return notReady(
        `DemoFlow needs Node.js ${DEMOFLOW_NODE_MAJOR} or later; this machine has ${node?.stdout.trim()}`,
      );
    }

    const version = demoflowCommand('--version');
    const fetched = await exec(version.binary, version.args, {
      timeoutMs: DEMOFLOW_FETCH_TIMEOUT_MS,
    });
    if (fetched === null) {
      return notReady('npx is not on the PATH, or fetching DemoFlow timed out');
    }
    if (fetched.code !== 0) {
      return notReady(
        `npx could not run DemoFlow ${DEMOFLOW_VERSION}: ${tail(fetched.stderr)}`,
      );
    }
    if (fetched.stdout.trim() !== DEMOFLOW_VERSION) {
      return notReady(
        `npx ran DemoFlow ${tail(fetched.stdout)}, not ${DEMOFLOW_VERSION}`,
      );
    }

    const setup = demoflowCommand('setup');
    const installed = await exec(setup.binary, setup.args, {
      timeoutMs: DEMOFLOW_SETUP_TIMEOUT_MS,
    });
    if (installed === null) return notReady('demoflow setup timed out');
    if (installed.code !== 0) {
      return notReady(
        `demoflow setup could not install Chromium: ${tail(installed.stderr || installed.stdout)}`,
      );
    }
    return { version: DEMOFLOW_VERSION, ready: true };
  }
}
