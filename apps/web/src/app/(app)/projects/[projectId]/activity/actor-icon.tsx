import type { ActivityActorType } from '@agentdock/shared';
import { Bot, Cog, Server, User } from 'lucide-react';
import { ACTOR_LABEL } from '../../../../../lib/history/format';

const ICON = {
  user: User,
  runner: Server,
  orchestrator: Bot,
  system: Cog,
} as const satisfies Record<ActivityActorType, typeof User>;

/** Who acted, as a glyph per type instead of the initials of a name. */
export function ActorIcon({ type }: { type: ActivityActorType }) {
  const Glyph = ICON[type];
  return (
    <span
      role="img"
      aria-label={ACTOR_LABEL[type]}
      title={ACTOR_LABEL[type]}
      className="inline-flex size-6 items-center justify-center rounded-full border border-line-strong bg-hover text-ink-2"
    >
      <Glyph aria-hidden="true" className="size-3.5" />
    </span>
  );
}
