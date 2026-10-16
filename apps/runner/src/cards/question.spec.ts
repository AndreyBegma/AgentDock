import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerSteps, matchQuestion, readQuestion } from './question';

// Captured from a Claude Code 2.1.301 pane (#473), each at a step of answering.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, '__fixtures__', `${name}.txt`), 'utf8');

const PERMISSION_PROMPT = `
 Bash command

   rm -rf node_modules

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to amend
`;

describe('the question selector (#473)', () => {
  it('matches one question, wherever the cursor is', () => {
    expect(matchQuestion(fixture('ask-user-question'))).toEqual({
      key: 'glass-ui',
    });
    expect(matchQuestion(fixture('ask-user-question-moved'))).toEqual({
      key: 'glass-ui',
    });
  });

  it('matches several questions with one key, the review screen too', () => {
    const tab = matchQuestion(fixture('ask-user-questions-two'));
    expect(tab).toEqual({ key: 'Colour Size Submit' });
    expect(matchQuestion(fixture('ask-user-questions-review'))).toEqual(tab);
  });

  it('no longer matches once the person answered', () => {
    expect(matchQuestion(fixture('ask-user-question-answered'))).toBeNull();
  });

  it('never matches a permission prompt, scrollback or a plain pane', () => {
    expect(matchQuestion(PERMISSION_PROMPT)).toBeNull();
    expect(
      matchQuestion(
        `${fixture('ask-user-question')}\n● Done.\n\n❯ \n  ⏵⏵ auto mode on\n`,
      ),
    ).toBeNull();
    expect(matchQuestion('> working on the card')).toBeNull();
    expect(matchQuestion('')).toBeNull();
  });
});

describe('reading and answering the selector (#489 M4)', () => {
  it('reads the question, its options and the cursor of one question', () => {
    const screen = readQuestion(fixture('ask-user-question'));
    expect(screen).toEqual({
      question: {
        key: expect.stringMatching(/^[0-9a-f]{16}$/),
        header: 'glass-ui',
        text: 'SelectionBar is missing in glass-ui — what now?',
        options: [
          {
            index: 1,
            label: 'Add it to glass-ui',
            description: 'Write the component in glass-ui first',
          },
          {
            index: 2,
            label: 'Use a Toolbar',
            description: 'Compose it from the existing Toolbar',
          },
        ],
        other: true,
      },
      cursor: 1,
      otherIndex: 3,
      numbers: [1, 2, 3, 4],
    });
    // The same screen with the cursor moved is the same question.
    const moved = readQuestion(fixture('ask-user-question-moved'));
    expect(moved?.cursor).toBe(2);
    expect(moved?.question).toEqual(screen?.question);
  });

  it('reads a tab of several questions, and the review screen without Other', () => {
    const tab = readQuestion(fixture('ask-user-questions-two'));
    expect(tab?.question.header).toBe('← Colour Size Submit →');
    expect(tab?.question.text).toBe('Which colour?');
    expect(tab?.question.options.map((o) => o.label)).toEqual(['Red', 'Blue']);
    const review = readQuestion(fixture('ask-user-questions-review'));
    expect(review?.question.text).toContain('Ready to submit your answers?');
    expect(review?.question.options.map((o) => o.label)).toEqual([
      'Submit answers',
      'Cancel',
    ]);
    expect(review?.question.other).toBe(false);
    expect(review?.question.key).not.toBe(tab?.question.key);
  });

  it('reads nothing once answered, or from a permission prompt', () => {
    expect(readQuestion(fixture('ask-user-question-answered'))).toBeNull();
    expect(readQuestion(PERMISSION_PROMPT)).toBeNull();
  });

  it('moves the cursor to the option, then presses Enter', () => {
    const screen = readQuestion(fixture('ask-user-question'));
    const moved = readQuestion(fixture('ask-user-question-moved'));
    if (!screen || !moved) throw new Error('no question');
    expect(answerSteps(screen, { index: 2 })).toEqual([
      { key: 'Down' },
      { key: 'Enter' },
    ]);
    expect(answerSteps(screen, { index: 1 })).toEqual([{ key: 'Enter' }]);
    expect(answerSteps(moved, { index: 1 })).toEqual([
      { key: 'Up' },
      { key: 'Enter' },
    ]);
    expect(answerSteps(moved, { text: 'Neither' })).toEqual([
      { key: 'Down' },
      { literal: 'Neither' },
      { key: 'Enter' },
    ]);
  });

  it('answers no option the screen does not list', () => {
    const screen = readQuestion(fixture('ask-user-question'));
    const review = readQuestion(fixture('ask-user-questions-review'));
    if (!screen || !review) throw new Error('no question');
    // 3 is "Type something.", 4 "Chat about this": neither is an option.
    for (const index of [0, 3, 4, 9]) {
      expect(answerSteps(screen, { index })).toBeNull();
    }
    expect(answerSteps(review, { text: 'x' })).toBeNull();
  });
});
