/** Version of the runner ↔ server wire protocol. The server may refuse others. */
export const PROTOCOL_VERSION = 1;

/** WebSocket path the runner dials on the server. */
export const RUNNER_SOCKET_PATH = '/runner';

/** Close codes the server uses on the runner socket. */
export const RUNNER_CLOSE_CODES = {
  /** `hello.protocolVersion` is not supported; the reason names the supported one. */
  protocolMismatch: 4400,
  /** Missing, unknown or revoked token. */
  unauthorized: 4401,
  /** A newer connection of the same runner replaced this one. */
  replaced: 4409,
} as const;

export type RunnerCloseCode =
  (typeof RUNNER_CLOSE_CODES)[keyof typeof RUNNER_CLOSE_CODES];
