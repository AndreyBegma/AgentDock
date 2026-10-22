const FALLBACK_LIVE_URL = 'ws://localhost:8180/live';

type PageLocation = Pick<Location, 'protocol' | 'host' | 'hostname'>;

/**
 * The live WebSocket URL. `NEXT_PUBLIC_LIVE_URL` wins, but a page served over
 * https never gets a `ws:` socket (it would be blocked, or travel in the
 * clear). Without it the URL follows the page: `wss:` behind the `/api` proxy
 * on https, the API's own development port on http.
 */
export function liveSocketUrl(
  configured: string | undefined = process.env.NEXT_PUBLIC_LIVE_URL,
  location: PageLocation | undefined = typeof window === 'undefined'
    ? undefined
    : window.location,
): string {
  const secure = location?.protocol === 'https:';
  if (configured) {
    return secure ? configured.replace(/^ws:/i, 'wss:') : configured;
  }
  if (!location) return FALLBACK_LIVE_URL;
  return secure
    ? `wss://${location.host}/api/live`
    : `ws://${location.hostname}:8180/live`;
}
