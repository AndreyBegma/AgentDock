import { Chip } from '@andrewbehma/glass-ui/chip';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';
import type { CardDemoBrief } from '@nautelle/shared';
import { Play } from 'lucide-react';
import { demoChip } from '../../lib/demos/format';

/** C-371: a board tile's one small demo chip (recording / ready / failed). */
export function DemoChip({ demo }: { demo: CardDemoBrief }) {
  const { label, tone, title } = demoChip(demo);
  return (
    <Tooltip content={title}>
      <Chip size="sm" tone={tone} data-demo-chip={demo.status}>
        {demo.status === 'ready' ? (
          <Play aria-hidden className="size-3" />
        ) : null}
        {label}
      </Chip>
    </Tooltip>
  );
}
