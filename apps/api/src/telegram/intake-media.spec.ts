import { intakeMediaOf } from './intake-media';
import type { TelegramMessage } from './telegram-client';

const message = (media: Partial<TelegramMessage>): TelegramMessage => ({
  message_id: 42,
  chat: { id: 1, type: 'private' },
  ...media,
});

describe('intakeMediaOf (#594)', () => {
  it('takes the largest size of a photo', () => {
    expect(
      intakeMediaOf(
        message({
          photo: [
            { file_id: 'small', width: 90, height: 60, file_size: 10 },
            { file_id: 'large', width: 1280, height: 853, file_size: 900 },
          ],
        }),
      ),
    ).toEqual({
      kind: 'image',
      fileId: 'large',
      size: 900,
      name: 'photo-42.jpg',
    });
  });

  it('takes an image document by its type, and nothing else', () => {
    expect(
      intakeMediaOf(
        message({
          document: {
            file_id: 'd',
            file_name: 'shot.png',
            mime_type: 'image/png',
          },
        }),
      ),
    ).toEqual({ kind: 'image', fileId: 'd', size: null, name: 'shot.png' });
    expect(
      intakeMediaOf(
        message({
          document: { file_id: 'p', mime_type: 'application/pdf' },
        }),
      ),
    ).toEqual({ kind: 'other' });
  });

  it('names a voice message and an audio note by their type', () => {
    expect(
      intakeMediaOf(
        message({ voice: { file_id: 'v', mime_type: 'audio/ogg' } }),
      ),
    ).toMatchObject({ kind: 'voice', name: 'voice.ogg', mime: 'audio/ogg' });
    expect(
      intakeMediaOf(
        message({ audio: { file_id: 'a', mime_type: 'audio/mp4' } }),
      ),
    ).toMatchObject({ kind: 'voice', name: 'voice.m4a', mime: 'audio/mp4' });
  });

  it('is null for text alone', () => {
    expect(intakeMediaOf(message({ text: 'hi' }))).toBeNull();
  });
});
