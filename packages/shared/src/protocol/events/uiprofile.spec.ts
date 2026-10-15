import { describe, expect, it } from 'bun:test';
import {
  isUiProfileBuildEventType,
  UIPROFILE_BUILD_EVENT_TYPES,
  uiProfileBuildEventDataSchemas,
} from '../index';

const ref = { runId: 'cmrun0001', projectId: 'prj_1' };
const at = '2026-10-14T10:00:00.000Z';

describe('uiprofile_build events', () => {
  it('names its two types, apart from plan_turn', () => {
    expect(UIPROFILE_BUILD_EVENT_TYPES).toEqual([
      'uiprofile_build.phase_changed',
      'uiprofile_build.finished',
    ]);
    expect(isUiProfileBuildEventType('uiprofile_build.finished')).toBe(true);
    expect(isUiProfileBuildEventType('plan_turn.finished')).toBe(false);
  });

  it('a finished build carries the raw result, unparsed', () => {
    const finished = uiProfileBuildEventDataSchemas['uiprofile_build.finished'];
    expect(
      finished.safeParse({
        ...ref,
        phase: 'succeeded',
        at,
        exitCode: 0,
        resultText: '```agentdock-plan\n{}\n```',
        resultTruncated: false,
      }).success,
    ).toBe(true);
    expect(
      finished.safeParse({
        ...ref,
        phase: 'running',
        at,
        resultTruncated: false,
      }).success,
    ).toBe(false);
    expect(
      finished.safeParse({
        ...ref,
        phase: 'succeeded',
        at,
        resultText: 'x'.repeat(192 * 1024 + 1),
        resultTruncated: false,
      }).success,
    ).toBe(false);
  });

  it('a phase change uses the plan turn phases', () => {
    const changed =
      uiProfileBuildEventDataSchemas['uiprofile_build.phase_changed'];
    expect(changed.safeParse({ ...ref, phase: 'running', at }).success).toBe(
      true,
    );
    expect(changed.safeParse({ ...ref, phase: 'done', at }).success).toBe(
      false,
    );
  });
});
