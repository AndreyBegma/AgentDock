import type {
  UnsequencedEvent,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { Clock } from '../clock';
import type { RunnerConfig } from '../config';
import type { Exec } from '../detect/exec';
import { errorMessage, type Logger } from '../log';
import { ProjectDirectory } from './projects';
import { DEFAULT_OTLP_HTTP_PORT, OTLP_HOST, OtlpReceiver } from './receiver';

export { OtlpReceiver } from './receiver';

/** The receiver settings from the runner config's `otlp` key (spec 13). */
export interface OtlpSettings {
  enabled: boolean;
  httpPort: number;
  codexExperimental: boolean;
}

/** `otlp: null` (the default) is the receiver on, on 4318. */
export const otlpSettings = (otlp: RunnerConfig['otlp']): OtlpSettings => ({
  enabled: otlp?.enabled ?? true,
  httpPort: otlp?.http ?? DEFAULT_OTLP_HTTP_PORT,
  codexExperimental: otlp?.codexExperimental ?? false,
});

export interface StartOtlpOptions {
  settings: OtlpSettings;
  emit: (event: UnsequencedEvent) => void;
  projects: () => readonly WatchedProject[];
  exec: Exec;
  clock: Clock;
  log: Logger;
}

/**
 * Starts the receiver when enabled. A port that cannot be bound (another
 * collector on 4318) is logged and the runner goes on without it: null.
 */
export const startOtlpReceiver = (
  options: StartOtlpOptions,
): OtlpReceiver | null => {
  const { settings, log } = options;
  if (!settings.enabled) return null;
  const directory = new ProjectDirectory({
    projects: options.projects,
    exec: options.exec,
  });
  const receiver = new OtlpReceiver({
    port: settings.httpPort,
    emit: options.emit,
    projects: (ids) => directory.resolve(ids),
    codexExperimental: settings.codexExperimental,
    now: () => new Date(options.clock.now()).toISOString(),
    log,
  });
  try {
    const port = receiver.start();
    log.info('otlp: receiver listening', { host: OTLP_HOST, port });
    return receiver;
  } catch (error) {
    log.error('otlp: cannot start the receiver', {
      port: settings.httpPort,
      error: errorMessage(error),
    });
    return null;
  }
};
