import {
  approvalKeyboard,
  CALLBACK_DATA_MAX,
  decodeCallback,
  encodeCallback,
  notePrompt,
  parseNotePrompt,
  serviceErrorText,
} from './approval-actions';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const target = {
  notificationId: 9_223_372_036_854_775_807n,
  pr: 123_456_789,
  headSha: SHA,
};

describe('approval callback data', () => {
  it('round-trips both actions and fits Telegram’s 64 bytes at the largest ids', () => {
    for (const action of ['approve', 'request_changes'] as const) {
      const data = encodeCallback({ ...target, action });
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(
        CALLBACK_DATA_MAX,
      );
      expect(decodeCallback(data)).toEqual({ ...target, action });
    }
  });

  it('refuses a head that is not a full SHA', () => {
    expect(() =>
      encodeCallback({ ...target, headSha: 'abc', action: 'approve' }),
    ).toThrow();
  });

  it('decodes nothing this bot did not encode', () => {
    const sha = encodeCallback({ ...target, action: 'approve' }).split(':')[3];
    expect(decodeCallback(`a:1:2:${sha}`)).toEqual({
      action: 'approve',
      notificationId: 1n,
      pr: 2,
      headSha: SHA,
    });
    for (const data of [
      undefined,
      '',
      'a:1:2',
      `x:1:2:${sha}`,
      `a:1:0:${sha}`,
      `a:-1:2:${sha}`,
      `a:1:2:${sha}A`,
      `a:1:2:${sha.slice(1)}`,
    ]) {
      expect(decodeCallback(data)).toBeNull();
    }
  });

  it('puts Approve and Request changes on one row', () => {
    const [row] = approvalKeyboard(target);
    expect(row.map((b) => b.text)).toEqual(['Approve', 'Request changes']);
    expect(decodeCallback(row[0].callback_data)?.action).toBe('approve');
    expect(decodeCallback(row[1].callback_data)?.action).toBe(
      'request_changes',
    );
  });
});

describe('note prompt', () => {
  it('carries its target in the text and gives it back', () => {
    const text = notePrompt(target);
    expect(text).toContain('PR #123456789');
    expect(text).toContain('Head a1b2c3d.');
    expect(parseNotePrompt(text)).toEqual(target);
  });

  it('finds no target in other text', () => {
    expect(parseNotePrompt(undefined)).toBeNull();
    expect(parseNotePrompt('Linked to AgentDock.')).toBeNull();
    expect(parseNotePrompt(`Ref 1/0/${SHA}`)).toBeNull();
    expect(parseNotePrompt(`Ref 1/2/${SHA.slice(1)}`)).toBeNull();
  });
});

describe('serviceErrorText', () => {
  it('names a moved head as in the UI, and never echoes an unknown code', () => {
    expect(serviceErrorText('head_moved', 7)).toBe(
      'PR #7 has new commits since this message. Review the new head in AgentDock.',
    );
    expect(serviceErrorText('<script>', 7)).toBe(
      'The decision could not be recorded. Try again, or decide in AgentDock.',
    );
  });
});
