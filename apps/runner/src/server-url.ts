import { PAIRING_PATH, RUNNER_SOCKET_PATH } from '@nautelle/shared/protocol';

export class ServerUrlError extends Error {}

/** `localhost`, `127.0.0.0/8` and `::1` — where plain http never leaves the machine. */
const isLoopbackHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  );
};

/**
 * Validates `<server>` — the API origin — and returns it without a trailing
 * slash. `https:` always; `http:` only for a loopback host, or for any host
 * when `insecure` is set (the runner-local `insecureServer`, D-06).
 */
export const normalizeServer = (server: string, insecure = false): string => {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new ServerUrlError(`not a URL: ${server}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerUrlError(`server must be https://, got ${url.protocol}`);
  }
  if (url.protocol === 'http:' && !insecure && !isLoopbackHost(url.hostname)) {
    throw new ServerUrlError(
      `server ${url.origin} is plain http: the token and session content would travel in cleartext. Use https://, or pair with --insecure to accept the risk`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ServerUrlError(
      'server must not carry credentials, a query or a fragment',
    );
  }
  return url.toString().replace(/\/+$/, '');
};

const at = (server: string, path: string, insecure: boolean): URL =>
  new URL(`${normalizeServer(server, insecure)}${path}`);

/** `POST <server>/runners/pair`. */
export const pairingUrl = (server: string, insecure = false): string =>
  at(server, PAIRING_PATH, insecure).toString();

/** `<server>/runner` over `ws:` for `http:`, `wss:` for `https:`. */
export const socketUrl = (server: string, insecure = false): string => {
  const url = at(server, RUNNER_SOCKET_PATH, insecure);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};
