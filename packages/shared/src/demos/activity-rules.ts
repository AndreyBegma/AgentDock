import {
  type EventContext,
  type EventRule,
  fixed,
  int,
  str,
} from '../activity/rules';
import { cardLabel } from '../board/naming';
import { API_EVENT_SOURCE } from '../protocol/envelope';
import { CARD_DEMO_EVENTS } from './contracts';

/**
 * C-370: the `card.demo_*` events the API records itself (ADR-0014) when a
 * card's demo ends — actor `system`, only from `source` `api`. Internal to
 * the package: `activity/types` spreads it into the type map.
 */

const KEEP = ['cardId', 'number', 'demoId', 'round', 'trigger', 'reason'];

const label = (ctx: EventContext): string => {
  const number = int(ctx.data, 'number');
  return number !== null ? cardLabel(number) : 'A card';
};

const linkOf = (ctx: EventContext): string | null => {
  if (!ctx.projectId) return null;
  const number = int(ctx.data, 'number');
  return `/projects/${ctx.projectId}/board${number !== null ? `?card=${number}` : ''}`;
};

export const DEMO_EVENT_RULES: Record<string, EventRule> = {
  [CARD_DEMO_EVENTS.ready]: {
    category: 'fleet',
    severity: fixed('ok'),
    title: (ctx) => `${label(ctx)}: demo video ready`,
    keep: KEEP,
    bySystem: true,
    sources: [API_EVENT_SOURCE],
    link: linkOf,
  },
  [CARD_DEMO_EVENTS.failed]: {
    category: 'fleet',
    severity: fixed('warn'),
    title: (ctx) => {
      const reason = str(ctx.data, 'reason');
      return `${label(ctx)}: demo failed${reason ? ` — ${reason}` : ''}`;
    },
    keep: KEEP,
    bySystem: true,
    sources: [API_EVENT_SOURCE],
    link: linkOf,
  },
};
