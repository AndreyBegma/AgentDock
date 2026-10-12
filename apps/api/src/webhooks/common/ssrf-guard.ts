import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { BlockList, isIP } from 'node:net';
import {
  WEBHOOK_ATTEMPT_ERRORS,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_RESPONSE_BODY_MAX_BYTES,
  type WebhookAttemptError,
} from '@agentdock/shared';

/**
 * The SSRF guard of outbound webhooks (docs/specs/26-webhooks.md D15). A URL
 * is checked when it is saved and again before every attempt: the host is
 * resolved, **every** address is checked, and the connection is made to the
 * checked address — there is no second lookup a DNS answer could change.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address it has. Tests inject a fake. */
export type HostResolver = (host: string) => Promise<ResolvedAddress[]>;

export const systemResolver: HostResolver = async (host) => {
  const found = await dnsLookup(host, { all: true, verbatim: true });
  return found.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

/** Ranges no outbound webhook may reach unless an admin allowlisted it. */
const BLOCKED = (() => {
  const list = new BlockList();
  const v4: [string, number][] = [
    ['0.0.0.0', 8], // unspecified / "this network"
    ['10.0.0.0', 8], // private
    ['100.64.0.0', 10], // CGNAT, Tailscale
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local, cloud metadata
    ['172.16.0.0', 12], // private
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.168.0.0', 16], // private
    ['198.18.0.0', 15], // benchmarking
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, broadcast
  ];
  const v6: [string, number][] = [
    ['::', 96], // unspecified, loopback, IPv4-compatible
    ['64:ff9b::', 96], // NAT64: embeds an IPv4 address
    ['2002::', 16], // 6to4: embeds an IPv4 address
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['ff00::', 8], // multicast
  ];
  for (const [net, bits] of v4) list.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of v6) list.addSubnet(net, bits, 'ipv6');
  return list;
})();

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** An IPv4-mapped IPv6 address is checked as the IPv4 address it carries. */
const canonical = (address: string): ResolvedAddress => {
  const mapped = MAPPED_V4.exec(address);
  if (mapped) return { address: mapped[1], family: 4 };
  return { address, family: isIP(address) === 6 ? 6 : 4 };
};

const ipType = (family: 4 | 6) => (family === 6 ? 'ipv6' : 'ipv4');

/** True when the address is in a range D15 refuses by default. */
export const isBlockedAddress = (address: string): boolean => {
  const { address: ip, family } = canonical(address);
  return BLOCKED.check(ip, ipType(family));
};

/**
 * `webhooks.allowedPrivateTargets` (D15): host names matched exactly, and IP
 * addresses or CIDRs matched against every resolved address.
 */
export class TargetAllowlist {
  private readonly hosts = new Set<string>();
  private readonly ranges = new BlockList();

  constructor(entries: readonly string[]) {
    for (const raw of entries) {
      const entry = raw.trim().toLowerCase();
      const slash = entry.indexOf('/');
      const address = slash >= 0 ? entry.slice(0, slash) : entry;
      const family = isIP(address);
      if (family === 0) {
        if (slash < 0 && entry) this.hosts.add(entry);
        continue;
      }
      const max = family === 6 ? 128 : 32;
      const bits = slash >= 0 ? Number(entry.slice(slash + 1)) : max;
      if (!Number.isInteger(bits) || bits < 0 || bits > max) continue;
      this.ranges.addSubnet(address, bits, family === 6 ? 'ipv6' : 'ipv4');
    }
  }

  hasHost(host: string): boolean {
    return this.hosts.has(host.toLowerCase());
  }

  hasAddress(address: string): boolean {
    const { address: ip, family } = canonical(address);
    return this.ranges.check(ip, ipType(family));
  }
}

/** Validates an `allowedPrivateTargets` entry the way `TargetAllowlist` reads it. */
export const isValidAllowlistEntry = (entry: string): boolean => {
  const value = entry.trim().toLowerCase();
  const slash = value.indexOf('/');
  if (slash < 0) return value.length > 0;
  const family = isIP(value.slice(0, slash));
  const bits = value.slice(slash + 1);
  if (family === 0 || !/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (family === 6 ? 128 : 32);
};

export type TargetCheck =
  | {
      ok: true;
      url: URL;
      /** The host without IPv6 brackets. */
      host: string;
      /** Every address the host resolved to; all of them passed. */
      addresses: ResolvedAddress[];
      /** The address to connect to. */
      connectTo: ResolvedAddress;
    }
  | {
      ok: false;
      error:
        | typeof WEBHOOK_ATTEMPT_ERRORS.blockedAddress
        | typeof WEBHOOK_ATTEMPT_ERRORS.httpsRequired
        | typeof WEBHOOK_ATTEMPT_ERRORS.unresolvable
        | 'invalid_url';
      /** The refused address, for the delivery log. */
      address?: string;
    };

/**
 * D15. Refuses a URL that is not absolute `http(s)`, carries credentials, does
 * not resolve, or resolves to any blocked address that the allowlist does not
 * cover. Plain `http://` is allowed only to an allowlisted host or to
 * addresses all inside allowlisted ranges.
 */
export const checkWebhookTarget = async (
  rawUrl: string,
  allowlist: TargetAllowlist,
  resolve: HostResolver = systemResolver,
): Promise<TargetCheck> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false, error: 'invalid_url' };
  if (url.username || url.password) return { ok: false, error: 'invalid_url' };
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host) return { ok: false, error: 'invalid_url' };

  let addresses: ResolvedAddress[];
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, error: WEBHOOK_ATTEMPT_ERRORS.unresolvable };
    }
  }
  if (addresses.length === 0)
    return { ok: false, error: WEBHOOK_ATTEMPT_ERRORS.unresolvable };

  const hostAllowed = allowlist.hasHost(host);
  for (const { address } of addresses) {
    if (
      isBlockedAddress(address) &&
      !hostAllowed &&
      !allowlist.hasAddress(address)
    )
      return {
        ok: false,
        error: WEBHOOK_ATTEMPT_ERRORS.blockedAddress,
        address,
      };
  }

  if (
    url.protocol === 'http:' &&
    !hostAllowed &&
    !addresses.every(({ address }) => allowlist.hasAddress(address))
  )
    return { ok: false, error: WEBHOOK_ATTEMPT_ERRORS.httpsRequired };

  return { ok: true, url, host, addresses, connectTo: addresses[0] };
};

// ─── The pinned POST (D12, D15) ─────────────────────────────────────────────

export interface GuardedPostRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  allowlist: TargetAllowlist;
  resolve?: HostResolver;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** One attempt's outcome, ready for `webhook_deliveries`. */
export interface GuardedPostResult {
  /** A 2xx answer. */
  succeeded: boolean;
  /** Null when no response arrived. */
  status: number | null;
  /** At most `maxResponseBytes` of the response body, decoded as UTF-8. */
  body: string | null;
  error: WebhookAttemptError | null;
  /** The refused address on `blocked_address`. */
  address?: string;
}

/** Answers every lookup with the already-checked address: no second resolution. */
const pinnedLookup =
  (pinned: ResolvedAddress): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };

/**
 * D12 + D15: check the target, then POST to the checked address with the
 * original host name (Host header, TLS SNI and certificate check unchanged).
 * Redirects are never followed — a 3xx is a failed attempt (`redirect`). The
 * response body is read up to the cap and the connection then dropped.
 */
export const guardedPost = async (
  request: GuardedPostRequest,
): Promise<GuardedPostResult> => {
  const check = await checkWebhookTarget(
    request.url,
    request.allowlist,
    request.resolve,
  );
  if (!check.ok) {
    return {
      succeeded: false,
      status: null,
      body: null,
      error:
        check.error === 'invalid_url'
          ? WEBHOOK_ATTEMPT_ERRORS.unresolvable
          : check.error,
      address: check.address,
    };
  }

  const timeoutMs = request.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  const maxBytes = request.maxResponseBytes ?? WEBHOOK_RESPONSE_BODY_MAX_BYTES;
  const client = check.url.protocol === 'https:' ? https : http;

  return new Promise<GuardedPostResult>((resolvePromise) => {
    let settled = false;
    const finish = (result: GuardedPostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const failed = (error: WebhookAttemptError): GuardedPostResult => ({
      succeeded: false,
      status: null,
      body: null,
      error,
    });

    const req = client.request(
      check.url,
      {
        method: 'POST',
        headers: {
          ...request.headers,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(request.body)),
        },
        lookup: pinnedLookup(check.connectTo),
        // No pooled socket: every attempt connects to the address it checked.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
          const body = Buffer.concat(chunks)
            .subarray(0, maxBytes)
            .toString('utf8');
          const succeeded = status >= 200 && status < 300;
          finish({
            succeeded,
            status,
            body,
            error: succeeded
              ? null
              : status >= 300 && status < 400
                ? WEBHOOK_ATTEMPT_ERRORS.redirect
                : WEBHOOK_ATTEMPT_ERRORS.httpStatus,
          });
        };
        res.on('data', (chunk: Buffer) => {
          if (size >= maxBytes) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxBytes) {
            done();
            res.destroy();
          }
        });
        res.on('end', done);
        res.on('error', done);
        res.on('close', done);
      },
    );

    const timer = setTimeout(() => {
      finish(failed(WEBHOOK_ATTEMPT_ERRORS.timeout));
      req.destroy();
    }, timeoutMs);

    req.on('error', () => finish(failed(WEBHOOK_ATTEMPT_ERRORS.network)));
    req.end(request.body);
  });
};
