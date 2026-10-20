'use client';

import { StatusPill } from '@andrewbehma/glass-ui/status-pill';
import type { FleetGraph } from '@nautelle/shared';
import {
  NODE_PILL_LABEL,
  NODE_PILL_STATUS,
} from '../../../../../../lib/slot/format';
import {
  relationsOf,
  type SlotLink,
} from '../../../../../../lib/slot/relations';

function Links({
  title,
  empty,
  links,
  onOpenSlot,
}: {
  title: string;
  empty: string;
  links: SlotLink[];
  onOpenSlot?: (slot: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-ink-2">{title}</h4>
      {links.length === 0 ? (
        <p className="text-xs text-ink-3">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {links.map((link) => {
            const label = (
              <>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {link.slot}
                  {link.issue !== null ? (
                    <span className="font-normal text-ink-3">
                      {' '}
                      #{link.issue}
                    </span>
                  ) : null}
                </span>
                <StatusPill
                  status={NODE_PILL_STATUS[link.pill]}
                  label={link.planned ? 'planned' : NODE_PILL_LABEL[link.pill]}
                />
              </>
            );
            return (
              <li key={link.slot}>
                {onOpenSlot ? (
                  <button
                    type="button"
                    onClick={() => onOpenSlot(link.slot)}
                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm hover:bg-hover"
                    title={link.issueTitle ?? undefined}
                  >
                    {label}
                  </button>
                ) : (
                  <span className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    {label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Sub-agents and dependencies of the slot, from the fleet graph's edges. */
export function Relations({
  graph,
  slot,
  onOpenSlot,
}: {
  graph: FleetGraph | undefined;
  slot: string;
  onOpenSlot?: (slot: string) => void;
}) {
  if (!graph) return null;
  const relations = relationsOf(graph, slot);
  if (!relations.onGraph) return null;
  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <section aria-label="Sub-agents">
        <Links
          title="Sub-agents"
          empty="None. Siblings this slot leads show here."
          links={relations.subAgents}
          onOpenSlot={onOpenSlot}
        />
      </section>
      <section aria-label="Dependencies" className="flex flex-col gap-3">
        <Links
          title="Waits for"
          empty="Nothing: it can start as soon as it is dispatched."
          links={relations.waitsFor}
          onOpenSlot={onOpenSlot}
        />
        <Links
          title="Blocks"
          empty="Nothing waits for it."
          links={relations.blocks}
          onOpenSlot={onOpenSlot}
        />
      </section>
    </div>
  );
}
