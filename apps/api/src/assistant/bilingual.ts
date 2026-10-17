/**
 * ADR-0060 §4: one model call answers in the person's language and gives the
 * English text in a trailer after a marker. The reply streams up to the
 * marker; the trailer is held back and parsed once the call ends.
 */
export const ENGLISH_MARKER = '<<<agentdock:english>>>';

export interface BilingualTrailer {
  /** BCP 47 primary language of the person's latest message, e.g. `ru`. */
  language: string;
  /** The reply in English. */
  reply: string;
  /** The person's latest message in English. */
  message: string;
}

/** The longest end of `text` that is a start of the marker. */
const partialMarker = (text: string): number => {
  const max = Math.min(text.length, ENGLISH_MARKER.length - 1);
  for (let n = max; n > 0; n--) {
    if (ENGLISH_MARKER.startsWith(text.slice(-n))) return n;
  }
  return 0;
};

/**
 * Splits one model call's text stream into the reply shown as it arrives and
 * the trailer. `push` returns what may be streamed now; a piece that could be
 * the start of the marker waits for the next chunk.
 */
export class BilingualSplitter {
  private pending = '';
  private trailerText: string | null = null;
  private shown = '';

  push(chunk: string): string {
    if (this.trailerText !== null) {
      this.trailerText += chunk;
      return '';
    }
    const text = this.pending + chunk;
    const at = text.indexOf(ENGLISH_MARKER);
    let out: string;
    if (at >= 0) {
      out = text.slice(0, at);
      this.trailerText = text.slice(at + ENGLISH_MARKER.length);
      this.pending = '';
    } else {
      const hold = partialMarker(text);
      out = text.slice(0, text.length - hold);
      this.pending = text.slice(text.length - hold);
    }
    this.shown += out;
    return out;
  }

  /** Whatever was held back as a possible marker, once the call ended. */
  flush(): string {
    const out = this.trailerText === null ? this.pending : '';
    this.pending = '';
    this.shown += out;
    return out;
  }

  /** The streamed reply, without the whitespace before the marker. */
  get reply(): string {
    return this.shown.trim();
  }

  get trailer(): BilingualTrailer | null {
    return this.trailerText === null ? null : parseTrailer(this.trailerText);
  }
}

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The trailer's JSON, with or without a code fence; null when malformed. */
export const parseTrailer = (text: string): BilingualTrailer | null => {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const { language, reply, message } = value as Record<string, unknown>;
  if (typeof language !== 'string' || !LANGUAGE.test(language)) return null;
  if (typeof reply !== 'string' || typeof message !== 'string') return null;
  return {
    language: language.toLowerCase().split('-')[0],
    reply: reply.trim(),
    message: message.trim(),
  };
};
