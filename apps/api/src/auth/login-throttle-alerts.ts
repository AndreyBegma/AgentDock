import { Injectable, Logger } from '@nestjs/common';

/** An existing account whose failed password checks crossed the threshold. */
export interface AccountThrottled {
  userId: string;
  email: string;
  ip: string | undefined;
  failures: number;
  at: Date;
}

export type AccountThrottledListener = (
  event: AccountThrottled,
) => Promise<void>;

/**
 * Where notifications learn that an account is throttled (C-109). A registry
 * rather than an import: notifications sit above auth (live sockets need the
 * session guard), so auth cannot depend on them.
 */
@Injectable()
export class LoginThrottleAlerts {
  private readonly logger = new Logger(LoginThrottleAlerts.name);
  private readonly listeners: AccountThrottledListener[] = [];

  subscribe(listener: AccountThrottledListener): void {
    this.listeners.push(listener);
  }

  /** Never throws: the refusal it accompanies has already been decided. */
  async accountThrottled(event: AccountThrottled): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`account throttle alert failed: ${reason}`);
      }
    }
  }
}
