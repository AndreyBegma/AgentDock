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
      'agentdock-card-ab12',
      dialog,
    );
    expect(sent).toBe(true);
    expect(calls).toEqual([
      ['tmux', '-L', 's', 'send-keys', '-t', '=agentdock-card-ab12:', 'Escape'],
    ]);
  });
});
