import type {
  CardHandoffSetArgs,
  CardHandoffSetResult,
} from '@nautelle/shared/protocol';
import type { HandoffService } from './service';

export { HandoffWriter } from './haiku';
export { RunNotes } from './runs';
export { type HandoffCard, HandoffService, handoffOn } from './service';
export { HandoffStateStore } from './state';

/** Context handoff's command (#449 D7). */
export interface HandoffHandlers {
  'card.handoff.set': (
    args: CardHandoffSetArgs,
  ) => Promise<CardHandoffSetResult>;
}

export const createHandoffHandlers = (
  service: HandoffService,
): HandoffHandlers => ({
  'card.handoff.set': (args) => service.setFromPerson(args),
});
