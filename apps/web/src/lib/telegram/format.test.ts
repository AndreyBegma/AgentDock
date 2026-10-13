import { describe, expect, test } from 'bun:test';
import { ApiError, errorText, toErrorHint } from '../api';
import {
  describeTelegramError,
  pollingNote,
  removeBotConsequence,
  TELEGRAM_LINK_PAGE,
} from './format';

const apiError = (code: string) => new ApiError(409, code as never, 'x');

describe('describeTelegramError', () => {
  test('"link your own Telegram first" is a link to where it is linked', () => {
    expect(
      toErrorHint(describeTelegramError(apiError('telegram_not_linked'))),
    ).toMatchObject({ href: TELEGRAM_LINK_PAGE, cta: 'Link your Telegram' });
  });

  test('a missing key gives the variable, an example and the restart (R4)', () => {
    const text = errorText(
      describeTelegramError(apiError('encryption_key_missing')),
    );
    expect(text).toContain('APP_ENCRYPTION_KEY=');
    expect(text).toContain('openssl rand -base64 32');
    expect(text).toContain('restart the API');
  });
});

describe('pollingNote', () => {
  test('explains "not running" for a configured bot, with what stops working', () => {
    const note = pollingNote({ configured: true, polling: false });
    expect(note).toContain('another one');
    expect(note).toContain('link codes');
  });

  test('says nothing is expected before a token is set', () => {
    expect(pollingNote({ configured: false, polling: false })).toContain(
      'token',
    );
  });
});

describe('removeBotConsequence', () => {
  test('names how many people stop getting notifications, and that links stay', () => {
    expect(removeBotConsequence({ linkedUsers: 3 })).toContain(
      'the 3 linked users',
    );
    expect(removeBotConsequence({ linkedUsers: 3 })).toContain('kept');
    expect(removeBotConsequence({ linkedUsers: 0 })).toContain('Nobody');
  });
});
