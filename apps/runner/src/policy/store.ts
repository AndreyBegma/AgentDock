import { statSync } from 'node:fs';
import { loadConfig } from '../config';
import { errorMessage, type Logger } from '../log';
import { defaultPolicy, type PolicyConfig } from './schema';

export interface PolicyStoreOptions {
  /** `runner.json`; the store only ever reads it. */
  configFile: string;
  log: Logger;
}

const SAME = (a: PolicyConfig, b: PolicyConfig) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The daemon's view of the runner-local policy (ADR-0047). It re-reads
 * `runner.json` when the file changed, so `nautelle-runner policy …` takes
 * effect without a restart. It never writes: the policy has one writer, the
 * CLI. A file that cannot be read gives the safe defaults, never the last
 * policy — a refusal is the failure mode, not an allow.
 */
export class PolicyStore {
  private policy: PolicyConfig;
  private stamp: string | null = null;
  /** Counts policy changes, so a caller can tell one happened since it looked. */
  private changes = 0;

  constructor(private readonly options: PolicyStoreOptions) {
    this.policy = defaultPolicy();
    this.refresh();
  }

  /** The policy as the file says now. */
  current(): PolicyConfig {
    this.refresh();
    return this.policy;
  }

  get version(): number {
    this.refresh();
    return this.changes;
  }

  /** Re-reads the file when it changed; true when the policy changed. */
  refresh(): boolean {
    const stamp = this.stampOf();
    if (stamp !== null && stamp === this.stamp) return false;
    this.stamp = stamp;
    const next = this.read();
    if (SAME(next, this.policy)) return false;
    this.policy = next;
    this.changes += 1;
    this.options.log.info('policy loaded', {
      allowedRoots: next.allowedRoots.length,
      maxPermissionMode: next.maxPermissionMode,
      terminalWrite: next.terminal.write,
      profileInstall: next.skills.profileInstall,
    });
    return true;
  }

  private stampOf(): string | null {
    try {
      const stat = statSync(this.options.configFile);
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  private read(): PolicyConfig {
    try {
      return loadConfig(this.options.configFile).policy;
    } catch (error) {
      this.options.log.error('cannot read the policy; using safe defaults', {
        error: errorMessage(error),
      });
      return defaultPolicy();
    }
  }
}
