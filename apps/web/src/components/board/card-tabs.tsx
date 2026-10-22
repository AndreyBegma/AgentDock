'use client';

import { Tab, TabGroup, TabList, TabPanel } from '@andrewbehma/glass-ui/tabs';
import { type ReactNode, useState } from 'react';

export type CardTab = 'overview' | 'rounds' | 'files' | 'edit';

/** Every card opens here: the run state is what a person came to see. */
export const DEFAULT_CARD_TAB: CardTab = 'overview';

const TAB_LABEL: Record<CardTab, string> = {
  overview: 'Overview',
  rounds: 'Rounds',
  files: 'Files',
  edit: 'Edit',
};

const TAB_ORDER: readonly CardTab[] = ['overview', 'rounds', 'files', 'edit'];

/**
 * The selected tab for card `cardId`. It lives above the card body, which is
 * remounted when a round is added, so a refresh does not lose the choice; a
 * different card starts on the default again.
 */
export function useCardTab(
  cardId: string | number | undefined,
): [CardTab, (tab: CardTab) => void] {
  const [state, setState] = useState<{ id: unknown; tab: CardTab }>({
    id: cardId,
    tab: DEFAULT_CARD_TAB,
  });
  if (state.id !== cardId) {
    setState({ id: cardId, tab: DEFAULT_CARD_TAB });
    return [DEFAULT_CARD_TAB, (tab) => setState({ id: cardId, tab })];
  }
  return [state.tab, (tab) => setState({ id: cardId, tab })];
}

/** The tabs a card shows: a panel that is `null` or `false` has no tab. */
export function visibleCardTabs(
  panels: Partial<Record<CardTab, ReactNode>>,
): CardTab[] {
  return TAB_ORDER.filter((tab) => {
    const panel = panels[tab];
    return panel !== null && panel !== undefined && panel !== false;
  });
}

/**
 * Overview, Rounds, Files and Edit as ARIA tabs. A section that is empty for
 * this card passes `null`, and its tab is not drawn; a selection that is not
 * drawn falls back to Overview. Panels not on screen are unmounted except Edit,
 * which keeps the person's unsaved typing across a switch.
 */
export function CardTabs({
  tab,
  onTabChange,
  panels,
  roundCount,
  className,
}: {
  tab: CardTab;
  onTabChange: (tab: CardTab) => void;
  panels: Partial<Record<CardTab, ReactNode>>;
  roundCount?: number;
  className?: string;
}) {
  const tabs = visibleCardTabs(panels);
  const selected = tabs.includes(tab) ? tab : DEFAULT_CARD_TAB;
  return (
    <div className={className}>
      <TabGroup
        value={selected}
        onValueChange={(value) => {
          const next = tabs.find((t) => t === value);
          if (next) onTabChange(next);
        }}
      >
        <div className="max-w-full overflow-x-auto">
          <TabList aria-label="Card sections" className="w-max min-w-full">
            {tabs.map((t) => (
              <Tab key={t} value={t}>
                {t === 'rounds' && roundCount
                  ? `${TAB_LABEL[t]} (${roundCount})`
                  : TAB_LABEL[t]}
              </Tab>
            ))}
          </TabList>
        </div>
        {tabs.map((t) => (
          <TabPanel
            key={t}
            value={t}
            keepMounted={t === 'edit'}
            className="min-w-0 pt-4"
          >
            {panels[t]}
          </TabPanel>
        ))}
      </TabGroup>
    </div>
  );
}
