import { Injectable } from '@nestjs/common';
import type { Schedule, ScheduleFiring } from '@prisma/client';

export type BeforeFireDecision =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * D12: the one pre-fire hook. It allows everything in #25; budgets (#28)
 * plug in here. A denial records the firing `skipped` with its reason.
 */
@Injectable()
export class BeforeFire {
  async check(
    _schedule: Schedule,
    _firing: ScheduleFiring,
  ): Promise<BeforeFireDecision> {
    return { allow: true };
  }
}
