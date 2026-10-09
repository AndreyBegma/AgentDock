import { PAIRING_PATH, RUNNER_SOCKET_PATH } from '@agentdock/shared/protocol';

export class ServerUrlError extends Error {}

/** Validates `<server>` — the API origin — and returns it without a trailing slash. */
export const normalizeServer = (server: string): string => {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new ServerUrlError(`not a URL: ${server}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerUrlError(`server must be http(s)://, got ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ServerUrlError(
      'server must not carry credentials, a query or a fragment',
    );
  }
  return url.toString().replace(/\/+$/, '');
};

const at = (server: string, path: string): URL =>
  new URL(`${normalizeServer(server)}${path}`);

/** `POST <server>/runners/pair`. */
export const pairingUrl = (server: string): string =>
  at(server, PAIRING_PATH).toString();

/** `<server>/runner` over `ws:` for `http:`, `wss:` for `https:`. */
export const socketUrl = (server: string): string => {
  const url = at(server, RUNNER_SOCKET_PATH);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};
