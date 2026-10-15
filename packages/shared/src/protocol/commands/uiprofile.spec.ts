import { describe, expect, it } from 'bun:test';
import { UIPROFILE_FINGERPRINT_MAX_GLOBS } from '../../design/limits';
import {
  commands,
  RUNNER_FEATURE_COMMANDS,
  uiProfileBuildArgsSchema,
  uiProfileCancelArgsSchema,
  uiProfileCancelResultSchema,
  uiProfileFingerprintArgsSchema,
  uiProfileFingerprintResultSchema,
  uiprofileCancelCommand,
  uiprofileCommands,
} from '../index';

const build = {
  projectId: 'prj_1',
  root: '/home/dev/repo',
  base: 'develop',
  runId: 'cmrun0001',
  prompt: '# UI profile\n\nDescribe this repository.',
  profileKey: 'blacktoorroot',
  model: 'opus',
  timeoutSec: 1200,
};

const fingerprint = {
  projectId: 'prj_1',
  root: '/home/dev/repo',
  base: 'develop',
  globs: ['apps/web/src/app/globals.css', 'packages/ui/src/**/*.tsx'],
};

describe('uiprofile commands', () => {
  it('both need an operator, and are in the allowlist the runner handles', () => {
    expect(uiprofileCommands['uiprofile.build'].minRole).toBe('operator');
    expect(uiprofileCommands['uiprofile.fingerprint'].minRole).toBe('operator');
    expect(Object.hasOwn(commands, 'uiprofile.build')).toBe(true);
    expect(Object.hasOwn(commands, 'uiprofile.fingerprint')).toBe(true);
  });

  it('uiprofile.build takes the prompt as a field, never empty', () => {
    expect(uiProfileBuildArgsSchema.safeParse(build).success).toBe(true);
    for (const bad of [
      { ...build, prompt: '  ' },
      { ...build, root: 'repo' },
      { ...build, base: '../main' },
      { ...build, extra: true },
    ]) {
      expect(uiProfileBuildArgsSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('uiprofile.fingerprint refuses a glob with .. or an absolute path', () => {
    expect(uiProfileFingerprintArgsSchema.safeParse(fingerprint).success).toBe(
      true,
    );
    for (const glob of ['../x/**', '/etc/**', 'a/../../b', 'C:/x']) {
      expect(
        uiProfileFingerprintArgsSchema.safeParse({
          ...fingerprint,
          globs: [glob],
        }).success,
      ).toBe(false);
    }
    expect(
      uiProfileFingerprintArgsSchema.safeParse({ ...fingerprint, globs: [] })
        .success,
    ).toBe(false);
    const many = Array.from(
      { length: UIPROFILE_FINGERPRINT_MAX_GLOBS + 1 },
      (_, i) => `src/${i}/**`,
    );
    expect(
      uiProfileFingerprintArgsSchema.safeParse({ ...fingerprint, globs: many })
        .success,
    ).toBe(false);
  });

  it('a fingerprint is a SHA-256 hex digest and a file count', () => {
    expect(
      uiProfileFingerprintResultSchema.safeParse({
        fingerprint: 'a'.repeat(64),
        files: 12,
      }).success,
    ).toBe(true);
    expect(
      uiProfileFingerprintResultSchema.safeParse({
        fingerprint: 'xyz',
        files: 12,
      }).success,
    ).toBe(false);
  });

  it('uiprofile.cancel takes only a run id, answers {cancelled}, needs an operator', () => {
    expect(uiprofileCancelCommand.minRole).toBe('operator');
    expect(uiprofileCancelCommand.timeoutMs).toBe(15_000);
    expect(
      uiProfileCancelArgsSchema.safeParse({ runId: 'cmrun0001' }).success,
    ).toBe(true);
    for (const bad of [
      {},
      { runId: '' },
      { runId: 'cmrun0001', projectId: 'prj_1' },
    ]) {
      expect(uiProfileCancelArgsSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      uiProfileCancelResultSchema.safeParse({ cancelled: true }).success,
    ).toBe(true);
    expect(uiProfileCancelResultSchema.safeParse({}).success).toBe(false);
  });

  it('uiprofile.cancel is not a design feature command: older runners keep generating', () => {
    expect(RUNNER_FEATURE_COMMANDS.design).not.toContain('uiprofile.cancel');
  });
});
