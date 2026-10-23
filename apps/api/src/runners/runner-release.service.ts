import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  latestReleased,
  RUNNER_RELEASE_OPTIONS,
  type RunnerReleaseOptions,
} from './runner-release';

/**
 * C-328: the latest released `nautelle-runner`, read from the npm registry
 * in the background and kept in memory. A runner read never waits on the
 * registry; a failed read keeps the last good value.
 */
@Injectable()
export class RunnerReleaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunnerReleaseService.name);
  private known: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(RUNNER_RELEASE_OPTIONS)
    private readonly options: RunnerReleaseOptions,
  ) {}

  onModuleInit(): void {
    if (this.options.autoStart) void this.tick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** The latest release, or null until the registry has answered once. */
  get latest(): string | null {
    return this.known;
  }

  /** Reads the registry once; true when it answered. */
  async refresh(): Promise<boolean> {
    try {
      this.known = await latestReleased(this.options.fetchLatest);
      return true;
    } catch (error) {
      this.logger.warn(
        `runner release check failed, keeping ${this.known ?? 'none'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async tick(): Promise<void> {
    const ok = await this.refresh();
    if (this.stopped) return;
    this.timer = setTimeout(
      () => void this.tick(),
      ok ? this.options.refreshMs : this.options.retryMs,
    );
    this.timer.unref();
  }
}
