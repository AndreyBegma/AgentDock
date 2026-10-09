import { isAbsolute, join } from 'node:path';
import {
  type ExitRecord,
  launchSpecSchema,
  RUN_FILES,
  readJson,
  writeJsonAtomic,
} from './record';

export interface ExecRunIo {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
}

/**
 * `agentdock-runner exec-run <runDir>` (D7) — what a run's tmux session
 * executes. Reads `run.json`, spawns the profile binary as an argv (never a
 * shell string) in the run worktree, sends its stdout to `stream.jsonl` and
 * its stderr to `stderr.log`, and records the exit in `exit.json`. Returns
 * the binary's exit code.
 */
export const execRun = async (
  argv: readonly string[],
  io: ExecRunIo,
): Promise<number> => {
  const [runDir, ...rest] = argv;
  if (!runDir || rest.length > 0 || !isAbsolute(runDir)) {
    io.stderr('Usage: agentdock-runner exec-run <absolute run directory>\n');
    return 2;
  }
  const spec = readJson(join(runDir, RUN_FILES.launch), launchSpecSchema);
  if (!spec) {
    io.stderr(
      `exec-run: ${join(runDir, RUN_FILES.launch)} is missing or invalid\n`,
    );
    return 1;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(io.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, spec.env);
  const binary = isAbsolute(spec.binary)
    ? spec.binary
    : Bun.which(spec.binary, { PATH: env.PATH ?? '' });

  const record = (exit: ExitRecord) =>
    writeJsonAtomic(join(runDir, RUN_FILES.exit), exit);
  if (!binary) {
    io.stderr(`exec-run: ${spec.binary} is not on PATH\n`);
    await Bun.write(
      join(runDir, RUN_FILES.stderr),
      `${spec.binary}: not found on PATH\n`,
    );
    record({ code: 127, signal: null, at: io.now().toISOString() });
    return 127;
  }

  io.stdout(`agentdock skill run · ${spec.binary} in ${spec.cwd}\n`);
  const child = Bun.spawn([binary, ...spec.args], {
    cwd: spec.cwd,
    env,
    stdin: 'ignore',
    stdout: Bun.file(join(runDir, RUN_FILES.stream)),
    stderr: Bun.file(join(runDir, RUN_FILES.stderr)),
  });
  const code = await child.exited;
  record({
    code: child.signalCode ? null : code,
    signal: child.signalCode ?? null,
    at: io.now().toISOString(),
  });
  io.stdout(
    `agentdock skill run · exited with ${child.signalCode ?? `code ${code}`}\n`,
  );
  return code;
};
