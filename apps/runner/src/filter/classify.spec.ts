import { describe, expect, it } from 'bun:test';
import {
  isProtectedLine,
  missingProtectedLines,
  protectedLines,
  stripAnsi,
} from './classify';

describe('protected lines (#445 D4b)', () => {
  it.each([
    'error TS2345: Argument of type string is not assignable',
    'src/a.ts(3,4): error TS1005',
    'FAIL src/spool.spec.ts',
    'Tests: 1 failed, 40 passed',
    '  ✗ drops the oldest segment',
    'warning: unused variable `x`',
    'npm WARN deprecated glob@7',
    'npm ERR! code ELIFECYCLE',
    '    at Spool.append (src/spool.ts:140:5)',
    '  File "app.py", line 3, in <module>',
    'Traceback (most recent call last):',
    "thread 'main' panicked at src/main.rs:2:5",
    '  --> src/main.rs:2:5',
    'goroutine 1 [running]:',
    'E       assert 1 == 2',
    'not ok 3 - adds',
    'Caused by: java.lang.NullPointerException',
    'Segmentation fault (core dumped)',
    'fatal: not a git repository',
    'bash: foo: command not found',
  ])('keeps %p', (line) => {
    expect(isProtectedLine(line)).toBe(true);
  });

  it.each([
    'ok 1 - parses a config',
    '✓ appends to the newest segment (2 ms)',
    'Compiled successfully in 3.2s',
    '',
    '   ',
    'Done in 1.4s.',
  ])('may drop %p', (line) => {
    expect(isProtectedLine(line)).toBe(false);
  });

  it('sees through colour escapes', () => {
    const red = '\u001b[31mFAIL\u001b[39m src/a.spec.ts';
    expect(stripAnsi(red)).toBe('FAIL src/a.spec.ts');
    expect(isProtectedLine(red)).toBe(true);
    expect(missingProtectedLines(red, 'FAIL src/a.spec.ts')).toEqual([]);
  });

  it('lists each distinct protected line once', () => {
    expect(protectedLines('Error: x\nok\nError: x\n  Error: x')).toEqual([
      'Error: x',
    ]);
  });

  it('reports a dropped or shortened line, not a re-indented one', () => {
    const original = 'ok 1\n    at f (a.ts:1:2)\nError: expected 1 to be 2\n';
    expect(
      missingProtectedLines(
        original,
        'at f (a.ts:1:2)\nError: expected 1 to be 2',
      ),
    ).toEqual([]);
    expect(
      missingProtectedLines(original, 'at f (a.ts:1:2)\nError: expected 1'),
    ).toEqual(['Error: expected 1 to be 2']);
  });
});
