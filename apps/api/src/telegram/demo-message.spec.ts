import { TELEGRAM_BOT_UPLOAD_MAX_BYTES } from '@nautelle/shared';
import { CARD_ACTION_CALLBACK } from './card-actions';
import {
  type DemoFacts,
  demoCaption,
  demoFailedLine,
  demoFitsUpload,
  demoKeyboard,
  demoOverLimitText,
} from './demo-message';

const facts: DemoFacts = {
  number: 12,
  title: 'Board filters',
  projectName: 'Nautelle',
  prNumber: 160,
  ciState: 'green',
  link: null,
};
const open = { text: 'Open card', web_app: { url: 'https://app/tg/12' } };

describe('demo message (C-372)', () => {
  it('fits a video of exactly 50 MB, not a byte more', () => {
    expect(demoFitsUpload(TELEGRAM_BOT_UPLOAD_MAX_BYTES)).toBe(true);
    expect(demoFitsUpload(TELEGRAM_BOT_UPLOAD_MAX_BYTES + 1)).toBe(false);
  });

  it('captions the video with the card, its pull request and CI', () => {
    expect(demoCaption(facts)).toBe(
      'C-12 demo: Board filters\nPR #160 · CI green\nNautelle',
    );
    expect(
      demoCaption({
        ...facts,
        prNumber: null,
        ciState: 'none',
        link: 'http://localhost:3000/projects/p/board?card=12',
      }),
    ).toBe(
      'C-12 demo: Board filters\nNo pull request yet · no CI checks\nNautelle\nhttp://localhost:3000/projects/p/board?card=12',
    );
  });

  it('sends a video over the limit to the card with its size', () => {
    const text = demoOverLimitText(
      { ...facts, ciState: 'pending' },
      61 * 1024 * 1024,
    );
    expect(text).toContain('PR #160 · CI running');
    expect(text).toContain(
      "The video is 61.0 MB, over Telegram's 50.0 MB limit for a bot: watch it on the card.",
    );
  });

  it('puts a failed demo on one line', () => {
    expect(demoFailedLine(12, 'Step 3 timed out\nat line 4')).toBe(
      'C-12 demo failed: Step 3 timed out at line 4',
    );
    expect(demoFailedLine(12, null)).toBe(
      'C-12 demo failed: the recording did not finish.',
    );
  });

  it('offers Merge only with a pull request and Accept allowed', () => {
    const merge = CARD_ACTION_CALLBACK.encode({
      card: 'k1a2b3c4',
      action: 'accept',
    });
    const feedback = CARD_ACTION_CALLBACK.encode({
      card: 'k1a2b3c4',
      action: 'feedback',
    });
    expect(
      demoKeyboard('k1a2b3c4', ['accept', 'feedback'], true, open),
    ).toEqual([
      [
        { text: 'Merge', callback_data: merge },
        { text: 'Feedback', callback_data: feedback },
      ],
      [open],
    ]);
    expect(
      demoKeyboard('k1a2b3c4', ['accept', 'feedback'], false, null),
    ).toEqual([[{ text: 'Feedback', callback_data: feedback }]]);
    expect(demoKeyboard('k1a2b3c4', [], true, null)).toEqual([]);
  });
});
