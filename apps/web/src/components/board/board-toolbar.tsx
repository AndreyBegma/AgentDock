'use client';

import { BOARD_CARD_KINDS } from '@agentdock/shared';
import { Input, Select } from '@andrewbehma/glass-ui/field';
import { Toolbar } from '@andrewbehma/glass-ui/toolbar';
import { Search } from 'lucide-react';
import {
  type BoardFilter,
  STATE_FILTER_LABEL,
  STATE_FILTERS,
} from '../../lib/board/filter';
import {
  type UrlFilters,
  useSearchDraft,
} from '../../lib/filters/use-url-filters';

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The board's filter bar (C-29): search over title, C-number and PR, Kind and
 * State as instant selects. The filters live in the URL.
 */
export function BoardToolbar({ url }: { url: UrlFilters<BoardFilter> }) {
  const { filters, set } = url;
  const text = useSearchDraft(filters.text, (value) => set({ text: value }));
  return (
    <Toolbar
      aria-label="Filter cards"
      collapseBelow="sm"
      filters={
        <>
          <div className="relative w-full sm:w-64">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <Input
              type="search"
              aria-label="Search cards"
              placeholder="Search — title, C-number, #PR"
              className="pl-8"
              value={text.draft}
              maxLength={200}
              onChange={(e) => text.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') text.flush();
              }}
            />
          </div>
          <Select
            aria-label="Kind"
            value={filters.kind}
            className="w-full sm:w-36"
            onChange={(e) =>
              set({ kind: (e.target.value as BoardFilter['kind']) || '' })
            }
          >
            <option value="">Any kind</option>
            {BOARD_CARD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {capitalize(kind)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="State"
            value={filters.state}
            className="w-full sm:w-44"
            onChange={(e) =>
              set({ state: (e.target.value as BoardFilter['state']) || '' })
            }
          >
            <option value="">Any state</option>
            {STATE_FILTERS.map((state) => (
              <option key={state} value={state}>
                {STATE_FILTER_LABEL[state]}
              </option>
            ))}
          </Select>
        </>
      }
    />
  );
}
