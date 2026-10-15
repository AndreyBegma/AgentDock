import { Injectable, Logger } from '@nestjs/common';

/**
 * Work to do when a runner has connected — its `hello` accepted and its
 * `welcome` sent, so commands can be sent to it (#329 D4: a failed
 * `card.collect` is retried then).
 */
export interface RunnerConnectHook {
  /** A short name for logs, e.g. 'board'. */
  readonly name: string;
  /** Must not throw for bad data; a throw is logged and the next hook runs. */
  connected(runnerId: string): Promise<void>;
}

/**
 * Where consumer modules register their connect hooks: import
 * `RunnersModule` and call `register(this)` in `onModuleInit`. The gateway
 * runs them off its frame queue, so a hook that sends a command never waits
 * on the frame that carries the answer.
 */
@Injectable()
export class RunnerConnectHooks {
  private readonly logger = new Logger(RunnerConnectHooks.name);
  private readonly hooks: RunnerConnectHook[] = [];

  register(hook: RunnerConnectHook): void {
    this.hooks.push(hook);
  }

  /** Runs every hook in registration order; a failing one never stops the rest. */
  async connected(runnerId: string): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.connected(runnerId);
      } catch (error) {
        this.logger.error(
          `connect hook ${hook.name} failed for runner ${runnerId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
