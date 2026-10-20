'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { type Column, DataTable } from '@andrewbehma/glass-ui/data-table';
import type { ModelPriceInput } from '@nautelle/shared';
import { ScrollX } from '../../../components/scroll-x/scroll-x';
import {
  defaultTier,
  describeConditions,
  formatPerMillion,
} from '../../../lib/usage/format';
import type { Draft } from './save-dialog';

/** Past this many rows a table windows itself instead of rendering them all. */
const VIRTUALIZE_FROM = 40;
const WINDOW_HEIGHT = 520;
const ROW_HEIGHT = 48;

const price = (value: string | undefined) => (
  <span className="num">{formatPerMillion(value)}</span>
);

/** One group of price rows: name, truncated pattern, prices per million tokens. */
export function ModelTable({
  models,
  draft,
  savedNames,
  onEdit,
  onToggleRemove,
}: {
  models: ModelPriceInput[];
  draft: Draft;
  savedNames: ReadonlySet<string>;
  onEdit: (model: ModelPriceInput) => void;
  onToggleRemove: (name: string) => void;
}) {
  const columns: Column<ModelPriceInput>[] = [
    {
      id: 'model',
      header: 'Model',
      cell: (model) => {
        const removed = draft.remove.has(model.modelName);
        const changed = draft.upsert.has(model.modelName);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={`truncate font-medium ${removed ? 'line-through' : ''}`}
              title={model.modelName}
            >
              {model.modelName}
            </span>
            {removed ? <Badge tone="danger" label="removed" /> : null}
            {changed ? (
              <Badge
                tone="warn"
                label={savedNames.has(model.modelName) ? 'edited' : 'new'}
              />
            ) : null}
          </span>
        );
      },
    },
    {
      id: 'pattern',
      header: 'Pattern',
      cell: (model) => (
        <code
          className="block max-w-36 truncate font-mono text-xs text-ink-2"
          title={model.matchPattern}
        >
          {model.matchPattern}
        </code>
      ),
    },
    {
      id: 'input',
      header: 'Input / 1M',
      align: 'end',
      cell: (model) => price(defaultTier(model)?.prices.input),
    },
    {
      id: 'output',
      header: 'Output / 1M',
      align: 'end',
      cell: (model) => price(defaultTier(model)?.prices.output),
    },
    {
      id: 'cacheRead',
      header: 'Cache / 1M',
      align: 'end',
      cell: (model) => price(defaultTier(model)?.prices.cacheRead),
    },
    {
      id: 'tiers',
      header: 'Tiers',
      cell: (model) => {
        const text =
          model.tiers.length > 1
            ? model.tiers
                .filter((tier) => !tier.isDefault)
                .map((tier) => `${tier.name}: ${describeConditions(tier)}`)
                .join('; ')
            : '—';
        return (
          <span className="block max-w-28 truncate" title={text}>
            {text}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      cell: (model) => {
        const removed = draft.remove.has(model.modelName);
        return (
          <span className="flex justify-end gap-2">
            <Button
              variant="glass"
              size="sm"
              aria-label={`Edit ${model.modelName}`}
              disabled={removed}
              onClick={() => onEdit(model)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${removed ? 'Keep' : 'Remove'} ${model.modelName}`}
              onClick={() => onToggleRemove(model.modelName)}
            >
              {removed ? 'Keep' : 'Remove'}
            </Button>
          </span>
        );
      },
    },
  ];

  const windowed = models.length > VIRTUALIZE_FROM;
  return (
    <ScrollX>
      <DataTable
        rows={models}
        columns={columns}
        getRowId={(model) => model.modelName}
        stickyHeader
        virtualize={windowed}
        rowHeight={ROW_HEIGHT}
        height={windowed ? WINDOW_HEIGHT : undefined}
      />
    </ScrollX>
  );
}
