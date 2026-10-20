import {
  CARD_REVIEW_ACTIONS,
  type CardPullRequestView,
} from '@nautelle/shared';
import { CALLBACK_DATA_MAX } from './callback-data';
import {
  acceptConfirm,
  actionOfWord,
  CARD_ACTION_CALLBACK,
  CARD_CONFIRM_CALLBACK,
  CARD_MERGE_CALLBACK,
  feedbackPrompt,
  messagePrompt,
  parseCardPrompt,
  reviewKeyboard,
} from './card-actions';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const card = {
  label: 'C-12',
  shortId: 'ab12cd34',
  source: 'manual' as const,
  prNumber: 514,
  baseBranch: 'develop',
};
const pr = (extra: Partial<CardPullRequestView> = {}): CardPullRequestView => ({
  number: 514,
  url: 'https://github.com/acme/widget/pull/514',
  state: 'open',
  headSha: HEAD,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  checks: 'green',
  method: null,
  canMerge: true,
  ...extra,
});

describe('Telegram card actions (#578)', () => {
  it('every card button fits in 64 bytes', () => {
    for (const codec of [
      CARD_ACTION_CALLBACK,
      CARD_CONFIRM_CALLBACK,
      CARD_MERGE_CALLBACK,
    ]) {
      expect(codec.maxBytes).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    }
  });

  it('every action fits its button, and its word names it back', () => {
    const rows = reviewKeyboard('ab12cd34', [...CARD_REVIEW_ACTIONS]);
    const decoded = rows
      .flat()
      .map((b) => CARD_ACTION_CALLBACK.decode(b.callback_data)?.action ?? '');
    expect(decoded.map(actionOfWord)).toEqual([...CARD_REVIEW_ACTIONS]);
  });

  it('a keyboard has the allowed actions, two to a row, and round-trips', () => {
    const rows = reviewKeyboard('ab12cd34', ['accept', 'feedback', 'collect']);
    expect(rows.map((row) => row.map((b) => b.text))).toEqual([
      ['Accept', 'Give feedback'],
      ['Create pull request'],
    ]);
    expect(CARD_ACTION_CALLBACK.decode(rows[0]?.[1]?.callback_data)).toEqual({
      card: 'ab12cd34',
      action: 'feedback',
    });
  });

  it('a prompt carries its card back, and nothing else parses', () => {
    expect(parseCardPrompt(feedbackPrompt('C-12', 'ab12cd34'))).toEqual({
      action: 'feedback',
      card: 'ab12cd34',
    });
    expect(
      parseCardPrompt(messagePrompt('C-12', 'slot-2', 'ab12cd34')),
    ).toEqual({ action: 'message', card: 'ab12cd34' });
    expect(parseCardPrompt('Ref card 12')).toBeNull();
    expect(parseCardPrompt('Ref feedback AB12CD34')).toBeNull();
  });

  it('Accept on an open, mergeable PR offers merge bound to its head, or accept without merging', () => {
    const { text, keyboard } = acceptConfirm(card, pr());
    expect(text).toBe(
      'Accept C-12?\nThis merges PR #514 into develop and moves the card to Completed.',
    );
    expect(keyboard.flat().map((b) => b.text)).toEqual([
      'Cancel',
      'Accept and merge',
      'Accept without merging',
    ]);
    expect(CARD_MERGE_CALLBACK.decode(keyboard[0]?.[1]?.callback_data)).toEqual(
      { card: 'ab12cd34', head: HEAD.slice(0, 12) },
    );
  });

  it('Accept never merges a fleet card, nor a PR the runner cannot merge', () => {
    for (const [input, prView] of [
      [{ ...card, source: 'fleet' as const }, pr()],
      [card, pr({ canMerge: false })],
      [card, null],
      [{ ...card, prNumber: null }, null],
    ] as const) {
      const { keyboard } = acceptConfirm(input, prView);
      expect(keyboard.flat().map((b) => b.text)).toEqual(['Cancel', 'Accept']);
      expect(
        CARD_CONFIRM_CALLBACK.decode(keyboard[0]?.[1]?.callback_data),
      ).toEqual({ card: 'ab12cd34', step: 'accept' });
    }
  });
});
