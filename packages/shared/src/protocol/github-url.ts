import { z } from 'zod';
import { TEXT_PATH_MAX } from './bounded';

/**
 * Whether `value` is an `https://github.com/…` URL: scheme `https` and the
 * hostname exactly `github.com` — no other scheme, no look-alike host
 * (`github.com.evil.example`), no userinfo, no port.
 */
export const isHttpsGithubUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.username === '' &&
    url.password === '' &&
    url.port === ''
  );
};

/** A link a runner reports to GitHub: shown in the web, Telegram and webhooks. */
export const httpsGithubUrl = z
  .string()
  .max(TEXT_PATH_MAX)
  .refine(isHttpsGithubUrl, { message: 'must be an https://github.com URL' });

/**
 * `httpsGithubUrl` for a runner event's optional link: a URL that fails the
 * rule is dropped, not the event that carries it.
 */
export const droppableGithubUrl = httpsGithubUrl.optional().catch(undefined);
