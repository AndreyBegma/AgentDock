/** Timings of the local module (spec 201). */
export interface LocalOptions {
  /** How often pending action requests past `expiresAt` expire (D18). */
  expiryIntervalMs: number;
  /** Off under `APP_ENV=test`: suites call `ActionRequestExpiryJob.sweep()`. */
  autoStart: boolean;
}

export const LOCAL_OPTIONS = Symbol('LOCAL_OPTIONS');

export const localOptionsFromEnv = (): LocalOptions => ({
  expiryIntervalMs: 60_000,
  autoStart: process.env.APP_ENV !== 'test',
});
