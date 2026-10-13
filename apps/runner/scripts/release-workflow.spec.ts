import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Woodpecker 3.x evaluates a workflow's `when` against the pipeline metadata
// (CI_*) only: the variables of a manual run reach the steps, never `when`.
// A gate on such a variable never matches, and the dry run cannot start
// (issue #135).

type Constraint = { event?: string; ref?: string; evaluate?: string };

const root = join(import.meta.dir, '..', '..', '..');
const workflow = Bun.YAML.parse(
  readFileSync(join(root, '.woodpecker', 'release-runner.yml'), 'utf8'),
) as { when: Constraint[] };

const manual = workflow.when.filter((c) => c.event === 'manual');

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
});
