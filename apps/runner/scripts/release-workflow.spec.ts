import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Woodpecker 3.x evaluates a workflow's `when` against the pipeline metadata
// (CI_*) only: the variables of a manual run reach the steps, never `when`.
// A gate on such a variable never matches, and the dry run cannot start
// (issue #135).

type Constraint = { event?: string; ref?: string; evaluate?: string };
type Step = {
  name: string;
  when?: Constraint[];
  environment?: Record<string, unknown>;
  commands?: string[];
};

const root = join(import.meta.dir, '..', '..', '..');
const workflow = Bun.YAML.parse(
  readFileSync(join(root, '.woodpecker', 'release-runner.yml'), 'utf8'),
) as { when: Constraint[]; steps: Step[] };

const manual = workflow.when.filter((c) => c.event === 'manual');
const secretsOf = (step: Step) =>
  Object.values(step.environment ?? {}).flatMap((value) =>
    typeof value === 'object' && value !== null && 'from_secret' in value
      ? [String(value.from_secret)]
      : [],
  );
const step = (name: string) => {
  const found = workflow.steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
};

describe('release-runner.yml', () => {
  it('starts on a runner-v* tag', () => {
    expect(workflow.when).toContainEqual({
      event: 'tag',
      ref: 'refs/tags/runner-v*',
    });
  });

  it('gates every manual run, so a plain manual run does not release', () => {
    expect(manual.length).toBeGreaterThan(0);
    for (const c of manual) expect(c.evaluate).toBeTruthy();
  });

  it('gates a manual run on metadata Woodpecker exposes to `when`', () => {
    for (const c of manual) {
      const names = (c.evaluate ?? '')
        .replace(/"[^"]*"|'[^']*'/g, '')
        .match(/[A-Za-z_][A-Za-z0-9_]*/g);
      const variables = (names ?? []).filter(
        (n) => !['contains', 'and', 'or', 'not', 'in', 'matches'].includes(n),
      );
      expect(variables.length).toBeGreaterThan(0);
      for (const v of variables) expect(v).toStartWith('CI_');
    }
  });

  it('starts a dry run from the [runner-release] message marker', () => {
    expect(manual).toContainEqual({
      event: 'manual',
      evaluate: 'CI_COMMIT_MESSAGE contains "[runner-release]"',
    });
  });

  // ADR-0047: the secrets are scoped to the tag event in Woodpecker; a step
  // that reads one must not run on any other event, or a manual run fails on
  // a secret it may not have.
  it('reads secrets only in steps that run on a runner-v* tag alone', () => {
    const withSecrets = workflow.steps.filter((s) => secretsOf(s).length > 0);
    expect(withSecrets.length).toBeGreaterThan(0);
    for (const s of withSecrets) {
      expect(s.when).toEqual([{ event: 'tag', ref: 'refs/tags/runner-v*' }]);
    }
  });

  it('signs a tag build with runner_signing_key, and a manual build without any secret', () => {
    expect(secretsOf(step('build-release'))).toEqual(['runner_signing_key']);
    expect(step('build-release').environment).toHaveProperty(
      'RUNNER_SIGNING_KEY',
    );
    const dry = step('build-release-dry-run');
    expect(dry.when).toEqual([{ event: 'manual' }]);
    expect(secretsOf(dry)).toEqual([]);
  });

  it('publishes SHA256SUMS.sig with the Release', () => {
    expect(step('github-release').commands?.join('\n')).toContain(
      'SHA256SUMS SHA256SUMS.sig',
    );
  });
});
