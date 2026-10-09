import {
  SESSION_COOKIE,
  type TerminalServerFrame,
  terminalServerFrameSchema,
} from '@agentdock/shared';
import { WebSocket } from 'ws';

export interface Closed {
  code: number;
  reason: string;
}

/** A browser-like `/terminal` client: session cookie, `Origin`, binary output. */
export class TestTerminalSocket {
  readonly socket: WebSocket;
  readonly closed: Promise<Closed>;
  readonly frames: TerminalServerFrame[] = [];
  readonly data: Buffer[] = [];

  constructor(
    url: string,
    { token, origin }: { token?: string; origin?: string },
  ) {
    const headers: Record<string, string> = {};
    if (token) headers.Cookie = `${SESSION_COOKIE}=${token}`;
    if (origin) headers.Origin = origin;
    this.socket = new WebSocket(url, { headers });
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.data.push(data as Buffer);
        return;
      }
      this.frames.push(
        terminalServerFrameSchema.parse(JSON.parse(String(data))),
      );
    });
    this.closed = new Promise((resolve) => {
      this.socket.on('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
    this.socket.on('error', () => {});
  }

  /** Everything received as binary so far, as text. */
  get output(): string {
    return Buffer.concat(this.data).toString();
  }

  async frame<T extends TerminalServerFrame['type']>(
    type: T,
    ms = 5_000,
  ): Promise<Extract<TerminalServerFrame, { type: T }>> {
    await waitFor(() => this.frames.some((f) => f.type === type), ms);
    return this.frames.find((f) => f.type === type) as Extract<
      TerminalServerFrame,
      { type: T }
    >;
  }
}

/** Polls `check` until it holds; fails after `ms`. */
export const waitFor = async (
  check: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
