import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_PER_CARD_MAX,
} from '@agentdock/shared';
import type { TelegramMessage } from './telegram-client';

/**
 * #594: what a message brings to the `/new` intake besides text — a photo
 * or an image sent as a file, which the plan holds as an attachment; a
 * voice message or an audio note, which is transcribed and never stored;
 * or a file of another kind, which is refused.
 */
export type IntakeMedia =
  | { kind: 'image'; fileId: string; size: number | null; name: string }
  | {
      kind: 'voice';
      fileId: string;
      size: number | null;
      name: string;
      mime: string;
    }
  | { kind: 'other' };

/** The Bot API downloads files up to 20 MB; a voice note past it is refused. */
export const VOICE_MAX_BYTES = 20 * 1024 * 1024;

const MIB = 1024 * 1024;

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

/** The message's media; null for a message of text alone. */
export const intakeMediaOf = (message: TelegramMessage): IntakeMedia | null => {
  // Telegram sends a photo in several sizes, the largest last.
  const photo = message.photo?.at(-1);
  if (photo) {
    return {
      kind: 'image',
      fileId: photo.file_id,
      size: photo.file_size ?? null,
      name: `photo-${message.message_id}.jpg`,
    };
  }
  const document = message.document;
  if (document) {
    return document.mime_type?.startsWith('image/')
      ? {
          kind: 'image',
          fileId: document.file_id,
          size: document.file_size ?? null,
          name: document.file_name ?? `image-${message.message_id}`,
        }
      : { kind: 'other' };
  }
  const audio = message.voice ?? message.audio;
  if (audio) {
    const mime = audio.mime_type ?? 'audio/ogg';
    return {
      kind: 'voice',
      fileId: audio.file_id,
      size: audio.file_size ?? null,
      // The service tells the format by the name's extension.
      name: audio.file_name ?? `voice.${AUDIO_EXTENSIONS[mime] ?? 'ogg'}`,
      mime,
    };
  }
  return null;
};

export const MEDIA_REPLIES = {
  voiceOff:
    'Voice input is off: no speech-to-text service is set up. Send it as text.',
  notImage:
    'Only photos and image files can be added to New work, so that file was not stored.',
  tooLarge: `That file is over the ${ATTACHMENT_MAX_BYTES / MIB} MiB limit, so it was not stored.`,
  voiceTooLarge: `That voice message is over ${VOICE_MAX_BYTES / MIB} MB, so it was not transcribed. Send a shorter one.`,
  tooMany: `A card holds at most ${ATTACHMENTS_PER_CARD_MAX} attachments, so that photo was not stored.`,
  downloadFailed:
    'The file could not be fetched from Telegram, so nothing was stored. Try again.',
  photoWaiting:
    'Photo attached. What should the new work do? Send the description as your next message.',
  photoAdded:
    'Photo added to the draft. The planner sees it from its next turn.',
  notHeard:
    'Nothing could be heard in that voice message. Try again, or send text.',
  transcribeFailed:
    'The voice message could not be transcribed. Try again, or send text.',
} as const;

/** The transcript, shown back so the person sees what was understood. */
export const heardText = (transcript: string): string =>
  `Heard: “${transcript}”`;

/** An attachment refusal (allowlist, size, quota) in the chat's words. */
export const notStoredText = (reason: string): string =>
  `That file was not stored: ${reason.replace(/\.$/, '')}.`;
