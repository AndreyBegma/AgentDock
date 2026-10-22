import { mkdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec } from '../detect/exec';
import type { Env, Paths } from '../env';
import { errorMessage } from '../log';
import { availableVersion, PACKAGE_NAME, platformPackage } from './check';
import {
  detectInstall,
  installArgv,
  manualCommand,
  serviceRestart,
} from './install';

/**
 * The commands a person runs at a terminal; only they offer an update
 * (C-327). `run` is the daemon, `mcp`, `hook`, `claude`, `register` and the
 * filter hooks belong to Claude Code, and `exec-run` to a skill run's tmux
 * session: none of them ever checks.
 */
export const UPDATE_CHECK_COMMANDS: ReadonlySet<string> = new Set([
  'pair',
  'status',
  'profiles',
  'install-service',
  'setup',
  'away',
  'policy',
  'version',
  '--version',
  '-v',
  'help',
  '--help',
  '-h',
]);

/** A request still running when the command ends gets this much longer. */
export const GRACE_MS = 300;

/** `update.json` beside `runner.json`: the version answered "never". */
export const UPDATE_FILE = 'update.json';

export interface UpdateDeps {
  /** The command the CLI runs, `argv[0]`. */
  command: string | undefined;
  env: Env;
  os: string;
  arch: string;
  current: string;
  /** The running binary, or null when the CLI runs from source. */
  binary: string | null;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  fetch: typeof fetch;
  /** Asks on the terminal; null when stdin ends. */
  ask: (question: string) => string | null;
  /** Runs an install with inherited stdio; resolves its exit code. */
  install: (argv: readonly string[]) => Promise<number>;
  exec: Exec;
  exists: (path: string) => boolean;
  stderr: (text: string) => void;
  paths: Pick<Paths, 'configDir' | 'serviceFile' | 'launchAgentFile'>;
  uid: number;
  timeoutMs?: number;
  graceMs?: number;
}

export interface UpdateCheck {
  /** After the command finished: asks when a newer version is ready. Never throws. */
  offer: () => Promise<void>;
}

/** A variable is set unless it is empty, `0` or `false`. */
const isSet = (value: string | undefined): boolean =>
  value !== undefined &&
  value !== '' &&
  value !== '0' &&
  value.toLowerCase() !== 'false';

export const readSkippedVersion = (configDir: string): string | null => {
  try {
    const value = JSON.parse(
      readFileSync(join(configDir, UPDATE_FILE), 'utf8'),
    ) as { skipVersion?: unknown } | null;
    return typeof value?.skipVersion === 'string' ? value.skipVersion : null;
  } catch {
    return null;
  }
};

/** Best effort: the answer still counts for this run when it cannot be kept. */
const writeSkippedVersion = (configDir: string, version: string): void => {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(configDir, UPDATE_FILE),
      `${JSON.stringify({ skipVersion: version })}\n`,
      { mode: 0o600 },
    );
  } catch {}
};

/**
 * Starts the registry check alongside the command, or returns null — and
 * makes no request — when this run must stay silent: not a terminal on both
 * stdin and stdout, CI, `NAUTELLE_NO_UPDATE_CHECK`, a command that is not a
 * person's, a run from source, or an npx / bunx / pnpm dlx cache.
 */
export const startUpdateCheck = (deps: UpdateDeps): UpdateCheck | null => {
  if (
    deps.command === undefined ||
    !UPDATE_CHECK_COMMANDS.has(deps.command) ||
    !deps.stdinIsTTY ||
    !deps.stdoutIsTTY ||
    isSet(deps.env.CI) ||
    isSet(deps.env.NAUTELLE_NO_UPDATE_CHECK) ||
    deps.binary === null
  ) {
    return null;
  }
  const platform = platformPackage(deps.os, deps.arch);
  const install = detectInstall(deps.binary);
  if (platform === null || install.kind === 'ephemeral') return null;
  const binary = deps.binary;
  const pending = availableVersion({
    fetch: deps.fetch,
    current: deps.current,
    platformPackage: platform,
    timeoutMs: deps.timeoutMs,
  });

  const restartNotice = async (version: string): Promise<void> => {
    const service = serviceRestart(
      deps.os,
      deps.uid,
      deps.paths.launchAgentFile,
      !deps.exists(binary),
    );
    const unit =
      deps.os === 'darwin'
        ? deps.paths.launchAgentFile
        : deps.paths.serviceFile;
    if (!service || !deps.exists(unit)) return;
    const [probe, args] = service.probe;
    if ((await deps.exec(probe, args))?.code !== 0) return;
    deps.stderr(
      `The ${PACKAGE_NAME} service still runs ${deps.current}. Restart it to run ${version}:\n  ${service.restart}\n`,
    );
  };

  const update = async (version: string): Promise<void> => {
    const answer = deps
      .ask(
        `Update ${PACKAGE_NAME} ${deps.current} → ${version}? [Y/n/never for this version] `,
      )
      ?.trim()
      .toLowerCase();
    if (answer === 'never') {
      writeSkippedVersion(deps.paths.configDir, version);
      deps.stderr(`Not asking again about ${version}.\n`);
      return;
    }
    if (answer !== '' && answer !== 'y' && answer !== 'yes') return;
    if (install.kind !== 'global') {
      deps.stderr(`Update it with: ${manualCommand(install, version)}\n`);
      return;
    }
    const argv = installArgv(install.manager, version);
    const command = argv.join(' ');
    let code: number;
    try {
      code = await deps.install(argv);
    } catch (error) {
      deps.stderr(`Could not run ${command}: ${errorMessage(error)}\n`);
      return;
    }
    if (code !== 0) {
      deps.stderr(
        `The update failed: ${command} exited with ${code}.${
          install.manager === 'npm'
            ? ' If npm needs root for global installs, see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally.'
            : ''
        }\n`,
      );
      return;
    }
    deps.stderr(`Updated ${PACKAGE_NAME} to ${version}.\n`);
    await restartNotice(version);
  };

  return {
    offer: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const version = await Promise.race([
          pending,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), deps.graceMs ?? GRACE_MS);
          }),
        ]);
        if (version === null) return;
        if (readSkippedVersion(deps.paths.configDir) === version) return;
        await update(version);
      } catch {
        // The command's own result is what the run reports.
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

/**
 * Writes `question` to `write` and reads one line from stdin, blocking. Null
 * when stdin ends or cannot be read.
 */
export const askOnTerminal =
  (write: (text: string) => void) =>
  (question: string): string | null => {
    write(question);
    const bytes: number[] = [];
    const byte = Buffer.alloc(1);
    for (;;) {
      let read: number;
      try {
        read = readSync(0, byte, 0, 1, null);
      } catch {
        return null;
      }
      if (read === 0) {
        return bytes.length > 0 ? Buffer.from(bytes).toString('utf8') : null;
      }
      if (byte[0] === 0x0a) break;
      bytes.push(byte[0] as number);
    }
    return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
  };
