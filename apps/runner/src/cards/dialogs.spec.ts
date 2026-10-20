import { describe, expect, it } from 'bun:test';
import type { Exec } from '../detect/exec';
import { answerDialog, KNOWN_DIALOGS, matchKnownDialog } from './dialogs';

// Captured from a card pane blocked on the dialog (C-75, profile andriybehma).
const TEACH_AUTO_MODE = `
 ╭──────────────────────────────────────────────────────────────╮
 │ Teach auto mode about your environment?                      │
 │                                                              │
 │ Auto mode blocked several actions in this profile.           │
 │                                                              │
 │ ❯ 1. Yes                                                     │
 │   2. Not now                                                 │
 │   3. Don't show again                                        │
 ╰──────────────────────────────────────────────────────────────╯
`;

const PERMISSION_PROMPT = `
 Bash command

   rm -rf node_modules

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands
   3. No, and tell Claude what to do differently (esc)
`;

describe('known blocking dialogs (#435)', () => {
  it('matches the Teach auto mode dialog and answers with Escape', () => {
    expect(matchKnownDialog(TEACH_AUTO_MODE)).toMatchObject({
      name: 'teach-auto-mode',
      key: 'Escape',
    });
  });

  it('never matches a permission prompt, an unknown dialog or a plain pane', () => {
    expect(matchKnownDialog(PERMISSION_PROMPT)).toBeNull();
    expect(
      matchKnownDialog('Some new modal?\n 1. Yes\n 2. Not now'),
    ).toBeNull();
    expect(matchKnownDialog('> working on the card')).toBeNull();
  });

  it('matches with key hints under the frame, and a typographic apostrophe', () => {
    expect(
      matchKnownDialog(
        `${TEACH_AUTO_MODE.replace("Don't", 'Don’t')}   Enter to confirm · Esc to cancel\n`,
      )?.name,
    ).toBe('teach-auto-mode');
  });

  // #447 DR-08: text an agent prints must never make the runner press a key.
  const INPUT_BOX = [
    '╭──────────────────────────────────────────────╮',
    '│ >                                            │',
    '╰──────────────────────────────────────────────╯',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');

  it('never matches the dialog text in the agent’s own output above the input box', () => {
    const quoted = [
      '● The runner answers this dialog with Escape:',
      '  Teach auto mode about your environment?',
      '   1. Yes',
      '   2. Not now',
      "   3. Don't show again",
      '',
    ].join('\n');
    expect(matchKnownDialog(`${quoted}\n${INPUT_BOX}\n`)).toBeNull();
    // Even the whole framed dialog, printed as output, is not the prompt.
    expect(matchKnownDialog(`${TEACH_AUTO_MODE}\n${INPUT_BOX}\n`)).toBeNull();
    // Nor in scrollback with more output after it.
    expect(
      matchKnownDialog(`${TEACH_AUTO_MODE}\n● Next step.\n  ⎿  done\n`),
    ).toBeNull();
  });

  it('never matches an unframed copy, a frame with other options, or a frame that is not closed', () => {
    expect(
      matchKnownDialog(
        "Teach auto mode about your environment?\n 1. Yes\n 2. Not now\n 3. Don't show again\n",
      ),
    ).toBeNull();
    expect(
      matchKnownDialog(TEACH_AUTO_MODE.replace('Not now', 'Allow always')),
    ).toBeNull();
    expect(matchKnownDialog(TEACH_AUTO_MODE.replace(/ ╭─+╮\n/, ''))).toBeNull();
    // The title must be the frame's first line, not text inside it.
    expect(
      matchKnownDialog(
        TEACH_AUTO_MODE.replace(
          '│ Teach auto mode about your environment?                      │',
          '│ Echo: Teach auto mode about your environment?                │',
        ),
      ),
    ).toBeNull();
  });

  it('lists no dialog that asks for a decision', () => {
    for (const dialog of KNOWN_DIALOGS) {
      expect(dialog.key).toBe('Escape');
    }
  });

  it('sends the key to the exact session with a fixed argv', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (bin, args) => {
      calls.push([bin, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    const [dialog] = KNOWN_DIALOGS;
    if (!dialog) throw new Error('no known dialogs');
    const sent = await answerDialog(
      exec,
      ['-L', 's'],
      'nautelle-card-ab12',
      dialog,
    );
    expect(sent).toBe(true);
    expect(calls).toEqual([
      ['tmux', '-L', 's', 'send-keys', '-t', '=nautelle-card-ab12:', 'Escape'],
    ]);
  });
});
