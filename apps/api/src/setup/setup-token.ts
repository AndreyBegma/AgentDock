import { generateToken, hashToken, safeEqual } from '../auth/tokens';

/**
 * C-367: the one-time token that guards the first-run setup. Only its hash is
 * kept, and only in this process: a restart issues a new one, and using it
 * once spends it.
 */
export class SetupToken {
  private hash: string | null = null;

  /** A new token; any earlier one stops working. */
  issue(): string {
    const token = generateToken();
    this.hash = hashToken(token);
    return token;
  }

  matches(token: string | undefined): boolean {
    return (
      this.hash !== null && !!token && safeEqual(hashToken(token), this.hash)
    );
  }

  spend(): void {
    this.hash = null;
  }
}
