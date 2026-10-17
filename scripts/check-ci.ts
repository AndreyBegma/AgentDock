/**
 * Checks the Woodpecker workflows in .woodpecker/ against the trust levels of
 * ADR-0049:
 *
 *   - a step or service that can run on a pull request mounts no volume (no
 *     Docker socket, no host cache, no host directory at all), is not
 *     privileged and reads no secret;
 *   - a step that can run on a tag (a release) mounts nothing but the Docker
 *     socket, so it never reuses a cache another pipeline wrote;
 *   - every `bun install` uses `--frozen-lockfile`.
 *
 *   bun scripts/check-ci.ts [workflow.yml ...]
 *
 * A condition this check cannot evaluate (branch, path, ref, evaluate) counts
 * as "may run": the check errs towards reporting. Exits 1 and lists the
 * violations when there are any.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

const DOCKER_SOCKET = '/var/run/docker.sock';

type Event = 'pull_request' | 'push' | 'tag' | 'manual';

type Condition = { event?: string | string[] };
type When = Condition | Condition[] | undefined;

type Step = {
  name?: string;
  when?: When;
  volumes?: unknown[];
  privileged?: boolean;
  environment?: Record<string, unknown>;
  secrets?: unknown[];
  commands?: unknown[];
};

type Workflow = {
  when?: When;
  steps?: Step[] | Record<string, Step>;
  services?: Step[] | Record<string, Step>;
};

/** Whether a `when` can match the event; unknown conditions may match. */
export const mayRunOn = (when: When, event: Event): boolean => {
  if (when === undefined) return true;
  const conditions = Array.isArray(when) ? when : [when];
  if (conditions.length === 0) return true;
  return conditions.some(
    (condition) =>
      condition.event === undefined || [condition.event].flat().includes(event),
  );
};

const entries = (steps: Workflow['steps']): Step[] =>
  steps === undefined
    ? []
    : Array.isArray(steps)
      ? steps
      : Object.entries(steps).map(([name, step]) => ({ name, ...step }));

/** The host side of a volume (`src:dst[:mode]`, or the long form). */
const volumeSource = (volume: unknown): string =>
  typeof volume === 'string'
    ? volume.split(':')[0]
    : String((volume as { source?: unknown })?.source ?? volume);

const readsSecret = (step: Step): boolean =>
  (step.secrets?.length ?? 0) > 0 ||
  Object.values(step.environment ?? {}).some(
    (value) =>
      typeof value === 'object' && value !== null && 'from_secret' in value,
  );

/** The violations of one parsed workflow; `file` only labels them. */
export const checkWorkflow = (file: string, workflow: Workflow): string[] => {
  const violations: string[] = [];
  const runsOnPullRequest = mayRunOn(workflow.when, 'pull_request');
  const runsOnTag = mayRunOn(workflow.when, 'tag');
  const all = [
    ...entries(workflow.services).map((step) => ({ step, kind: 'service' })),
    ...entries(workflow.steps).map((step) => ({ step, kind: 'step' })),
  ];

  for (const { step, kind } of all) {
    const label = `${file}: ${kind} \`${step.name ?? '?'}\``;
    const volumes = step.volumes ?? [];

    if (runsOnPullRequest && mayRunOn(step.when, 'pull_request')) {
      for (const volume of volumes) {
        const source = volumeSource(volume);
        violations.push(
          source === DOCKER_SOCKET
            ? `${label} mounts the Docker socket on a pull request`
            : `${label} mounts the host path ${source} on a pull request`,
        );
      }
      if (step.privileged) {
        violations.push(`${label} is privileged on a pull request`);
      }
      if (readsSecret(step)) {
        violations.push(`${label} reads a secret on a pull request`);
      }
    }

    if (runsOnTag && mayRunOn(step.when, 'tag')) {
      for (const volume of volumes) {
        const source = volumeSource(volume);
        if (source !== DOCKER_SOCKET) {
          violations.push(`${label} mounts the host path ${source} on a tag`);
        }
      }
    }

    for (const command of step.commands ?? []) {
      if (
        typeof command === 'string' &&
        /\bbun install\b/.test(command) &&
        !command.includes('--frozen-lockfile')
      ) {
        violations.push(
          `${label} runs \`bun install\` without --frozen-lockfile`,
        );
      }
    }
  }
  return violations;
};

if (import.meta.main) {
  const dir = join(root, '.woodpecker');
  const files = process.argv.slice(2).length
    ? process.argv.slice(2).map((file) => resolve(file))
    : readdirSync(dir)
        .filter((file) => /\.ya?ml$/.test(file))
        .map((file) => join(dir, file));

  const violations = files.flatMap((file) =>
    checkWorkflow(
      relative(root, file),
      Bun.YAML.parse(readFileSync(file, 'utf8')) as Workflow,
    ),
  );

  if (violations.length > 0) {
    console.error(
      `check-ci: ${violations.length} violation(s) of the CI trust levels (ADR-0049):`,
    );
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(`check-ci: ${files.length} workflow(s) ok`);
}
