import { describe, expect, it } from 'bun:test';
import {
  DEMO_UI_PATHS_DEFAULT,
  demoScenarioPath,
  demoScenarioPathSchema,
  demoSecretNameSchema,
  isDemoActive,
  runnerDemoEnvPath,
  runnerDemoVideoPath,
} from './contracts';

describe('demo contracts (ADR-0090)', () => {
  it('names the scenario after the card label and slug', () => {
    const path = demoScenarioPath({
      number: 412,
      title: 'Add usage export to the Budget page',
    });
    expect(path).toBe(
      'demoflow/cards/C-412-add-usage-export-to-the-budget-page.demo.json',
    );
    expect(demoScenarioPathSchema.safeParse(path).success).toBe(true);
  });

  it('refuses a scenario outside demoflow/cards or with a traversal', () => {
    for (const bad of [
      'demoflow/cards/../x.demo.json',
      '/demoflow/cards/C-1-a.demo.json',
      'demoflow/C-1-a.demo.json',
      'demoflow/cards/C-1-a.json',
      'demoflow/cards/C-0-a.demo.json',
    ]) {
      expect(demoScenarioPathSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('takes environment variable names as secret names', () => {
    expect(demoSecretNameSchema.safeParse('DEMO_ADMIN_PASSWORD').success).toBe(
      true,
    );
    expect(demoSecretNameSchema.safeParse('_X1').success).toBe(true);
    for (const bad of ['', 'lower', '1ABC', 'A-B', 'A B', 'A'.repeat(65)]) {
      expect(demoSecretNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('treats queued and recording as in flight', () => {
    expect(isDemoActive('queued')).toBe(true);
    expect(isDemoActive('recording')).toBe(true);
    expect(isDemoActive('ready')).toBe(false);
    expect(isDemoActive('failed')).toBe(false);
    expect(isDemoActive('skipped')).toBe(false);
  });

  it('defaults the UI paths to the web app, TSX and CSS', () => {
    expect(DEMO_UI_PATHS_DEFAULT).toEqual([
      'apps/web/**',
      '**/*.tsx',
      '**/*.css',
    ]);
  });

  it('builds the runner paths', () => {
    expect(runnerDemoVideoPath(7, 'abc')).toBe(
      '/runner/cards/7/demos/abc/video',
    );
    expect(runnerDemoEnvPath(7, 'abc')).toBe('/runner/cards/7/demos/abc/env');
  });
});
