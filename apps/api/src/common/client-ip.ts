import type { IncomingMessage } from 'node:http';
import proxyAddr from 'proxy-addr';
import { trustProxySetting } from '../configure-app';

type Trust = (address: string, hop: number) => boolean;

/** Express's `compileTrust`: the `trust proxy` setting as a predicate. */
export const compileTrust = (setting: boolean | number | string): Trust => {
  if (setting === true) return () => true;
  if (typeof setting === 'number') return (_address, hop) => hop < setting;
  if (setting === false) return () => false;
  return proxyAddr.compile(setting.split(',').map((value) => value.trim()));
};

/**
 * The client IP of a request Express never sees — a WebSocket upgrade — the
 * way `req.ip` reads it: `X-Forwarded-For` is believed only through the hops
 * `TRUST_PROXY` trusts, else the socket's peer (C-151, L-21).
 */
export const clientIp = (
  request: IncomingMessage,
  trust: Trust = compileTrust(
    trustProxySetting(process.env.TRUST_PROXY, process.env.APP_ENV),
  ),
): string | undefined =>
  request.socket.remoteAddress ? proxyAddr(request, trust) : undefined;
