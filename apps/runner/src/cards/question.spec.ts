import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchQuestion } from './question';

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
