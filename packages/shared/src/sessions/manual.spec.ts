import { describe, expect, it } from 'bun:test';
import { HOOK_EVENT_TYPES } from '../protocol';
import { issueFromBranch, liveStateAfter, sessionOriginOf } from './manual';

describe('issueFromBranch (spec 201 D14)', () => {
  it('reads the repository convention', () => {
    expect(issueFromBranch('feat/184-grill-rounds')).toBe(184);
    expect(issueFromBranch('chore/119-scheduler-registry')).toBe(119);
    expect(issueFromBranch('docs/201-claude-code-integration')).toBe(201);
  });

  it('returns null for anything else', () => {
    for (const branch of [
      'develop',
      'main',
      'feat/no-number',
      '184-x',
      'feat/0-x',
      null,
      undefined,
      '',
    ]) {
      expect(issueFromBranch(branch)).toBeNull();
    }
  });
});

describe('sessionOriginOf', () => {
  it('lets a slot win over hooks', () => {
    expect(
      sessionOriginOf({
        slotName: 'i42-api',
        claimedByRun: false,
        sawHookEvent: true,
      }),
    ).toBe('worker');
  });

  it('marks a hooked session without slot or run manual', () => {
    expect(
      sessionOriginOf({
        slotName: null,
        claimedByRun: false,
        sawHookEvent: true,
      }),
    ).toBe('manual');
    expect(
      sessionOriginOf({
        slotName: null,
        claimedByRun: true,
        sawHookEvent: true,
      }),
    ).toBe('run');
    expect(
      sessionOriginOf({
        slotName: null,
        claimedByRun: false,
        sawHookEvent: false,
      }),
    ).toBe('unknown');
  });
});

describe('liveStateAfter', () => {
  it('follows started → working → waiting → idle → ended', () => {
    expect(liveStateAfter('hook.session_started')).toBe('idle');
    expect(liveStateAfter('hook.prompt_submitted')).toBe('working');
    expect(liveStateAfter('hook.permission_requested')).toBe('waiting');
    expect(liveStateAfter('hook.stopped')).toBe('idle');
    expect(liveStateAfter('hook.session_ended')).toBe('ended');
  });

  it('leaves the state alone for tool results and notifications', () => {
    expect(liveStateAfter('hook.tool_finished')).toBeNull();
    expect(liveStateAfter('hook.notification')).toBeNull();
    expect(liveStateAfter('hook.pre_compact')).toBeNull();
    expect(HOOK_EVENT_TYPES.length).toBe(8);
  });
});
