/** Cloudflare Access service token (D-07): both halves, or neither. */
export interface AccessCredentials {
  clientId: string;
  clientSecret: string;
}

/** The headers Cloudflare Access reads; empty without credentials. */
export const accessHeaders = (
  credentials: AccessCredentials | undefined,
): Record<string, string> =>
  credentials
    ? {
        'CF-Access-Client-Id': credentials.clientId,
        'CF-Access-Client-Secret': credentials.clientSecret,
      }
    : {};

/** The stored pair, if `runner.json` holds both halves. */
export const accessOf = (config: {
  accessClientId?: string;
  accessClientSecret?: string;
}): AccessCredentials | undefined =>
  config.accessClientId && config.accessClientSecret
    ? {
        clientId: config.accessClientId,
        clientSecret: config.accessClientSecret,
      }
    : undefined;
