import { Section } from '@andrewbehma/glass-ui/section';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';

/** Placeholder: a later card of the Overview redesign fills this block. */
export function LiveSessions() {
  return (
    <Section title="Live sessions">
      <Skeleton className="h-24" />
    </Section>
  );
}
