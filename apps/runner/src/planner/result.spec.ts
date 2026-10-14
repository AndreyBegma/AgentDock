import { describe, expect, it } from 'bun:test';
import { cutBytes, streamSessionId, turnOutcome } from './result';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const exit0 = { code: 0, signal: null, at: '2026-10-13T12:00:00.000Z' };
const init = (id: string) =>
  JSON.stringify({ type: 'system', subtype: 'init', session_id: id });
const result = (text: string, isError = false) =>
  JSON.stringify({
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result: text,
  });

describe('plan turn result (D17)', () => {
  it('cuts at a byte limit without splitting a character', () => {
    expect(cutBytes('abc', 3)).toEqual({ text: 'abc', truncated: false });
    // "é" is two bytes: four bytes of "aéé" is "aé" plus half a character.
    expect(cutBytes('aéé', 4)).toEqual({ text: 'aé', truncated: true });
  });

  it('reads the session id from the last init line, and nothing from junk', () => {
    expect(streamSessionId(`${init(S1)}\nnot json\n${init(S2)}\n`)).toBe(S2);
    expect(streamSessionId(`${init('not-a-uuid')}\n`)).toBeNull();
    expect(streamSessionId('')).toBeNull();
  });

  it('succeeds with the result text and the reported session', () => {
    expect(
      turnOutcome({
        reason: 'exited',
        exit: exit0,
        stream: `${init(S2)}\n${result('done')}\n`,
        stderr: '',
        timeoutSec: 600,
        fallbackSessionId: S1,
      }),
    ).toEqual({
      phase: 'succeeded',
      exitCode: 0,
      sessionId: S2,
      resultText: 'done',
      resultTruncated: false,
    });
  });

  it('fails an error result, a missing result and a vanished session, keeping the text', () => {
    expect(
      turnOutcome({
        reason: 'exited',
        exit: exit0,
        stream: `${result('half', true)}\n`,
        stderr: '',
        timeoutSec: 600,
      }),
    ).toMatchObject({
      phase: 'failed',
      resultText: 'half',
      error: 'the session ended with an error result',
    });
    expect(
      turnOutcome({
        reason: 'exited',
        exit: exit0,
        stream: '',
        stderr: '',
        timeoutSec: 600,
      }).error,
    ).toBe('the session produced no result message');
    expect(
      turnOutcome({
        reason: 'vanished',
        exit: null,
        stream: '',
        stderr: '',
        timeoutSec: 600,
        fallbackSessionId: S1,
      }),
    ).toEqual({
      phase: 'failed',
      sessionId: S1,
      resultTruncated: false,
      error: 'the session ended without an exit status',
    });
  });

  it('reports the CLI error line, redacted', () => {
    const outcome = turnOutcome({
      reason: 'exited',
      exit: { ...exit0, code: 1 },
      stream: '',
      stderr:
        'warming up\nError: bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n',
      timeoutSec: 600,
    });
    expect(outcome.phase).toBe('failed');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toStartWith('Error: bad key');
    expect(outcome.error).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
