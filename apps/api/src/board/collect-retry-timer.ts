import { Injectable, type OnModuleDestroy } from '@nestjs/common';

/**
 * #329 D4: the one delayed retry of a failed `card.collect`, in process. A
 * timer lost to an API restart is covered by the retry on the runner's next
 * `hello`: every runner reconnects after a restart. One timer per card; a
 * new one replaces it.
 */
@Injectable()
export class CollectRetryTimer implements OnModuleDestroy {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  schedule(cardId: string, delayMs: number, run: () => void): void {
    this.cancel(cardId);
    const timer = setTimeout(() => {
      this.timers.delete(cardId);
      run();
    }, delayMs);
    timer.unref();
    this.timers.set(cardId, timer);
  }

  cancel(cardId: string): void {
    const timer = this.timers.get(cardId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(cardId);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
