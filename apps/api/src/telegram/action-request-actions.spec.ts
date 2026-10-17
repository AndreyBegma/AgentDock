import {
  actionRequestIdOfLink,
  actionRequestLink,
} from '../local/action-request-mapper';
import {
  actionRequestDecidedText,
  decodeActionRequestCallback,
  encodeActionRequestCallback,
  isActionRequestCallback,
} from './action-request-actions';
import { decodeCallback } from './approval-actions';

const ID = 'cmv84f8yx00ofd5j6crmj2ivw';

describe('action-request buttons (spec 201 D18)', () => {
  it('round-trips `x|y:<notification>:<request>` within 64 bytes', () => {
    for (const action of ['approve', 'deny'] as const) {
      const press = {
        action,
        notificationId: 9_223_372_036_854_775_807n,
        actionRequestId: ID,
      };
      const data = encodeActionRequestCallback(press);
      expect(data.startsWith(action === 'approve' ? 'x:' : 'y:')).toBe(true);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(decodeActionRequestCallback(data)).toEqual(press);
      expect(isActionRequestCallback(data)).toBe(true);
      // The PR buttons' decoder never takes it.
      expect(decodeCallback(data)).toBeNull();
    }
  });

  it('decodes nothing it did not encode', () => {
    for (const data of [
      undefined,
      '',
      'x:1',
      'z:1:abc',
      `x:-1:${ID}`,
      `x:1:${ID}/../`,
      `a:1:2:${'A'.repeat(27)}`,
    ]) {
      expect(decodeActionRequestCallback(data)).toBeNull();
    }
    expect(isActionRequestCallback(`a:1:2:${'A'.repeat(27)}`)).toBe(false);
  });

  it("carries the request id in the notification's link", () => {
    const link = actionRequestLink('prj_1', ID);
    expect(link).toBe(`/projects/prj_1/approvals?actionRequest=${ID}`);
    expect(actionRequestIdOfLink(link)).toBe(ID);
    expect(actionRequestIdOfLink('/projects/prj_1/fleet')).toBeNull();
    expect(actionRequestIdOfLink(null)).toBeNull();
  });

  it('says a moved head approved nothing (C-110)', () => {
    expect(actionRequestDecidedText('approve', 'failed', 'head_moved')).toBe(
      'Not approved: the pull request has new commits since this request. Ask for a new one.',
    );
    expect(actionRequestDecidedText('approve', 'failed', 'pr_not_open')).toBe(
      'Approved, but it could not be carried out: pr_not_open.',
    );
  });
});
