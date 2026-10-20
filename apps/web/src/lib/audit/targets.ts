import type { AuditRecordView } from '@nautelle/shared';

/** Names the audit page can resolve, keyed by the record's `targetType`. */
export interface NameSources {
  user?: readonly { id: string; email: string; name?: string | null }[];
  runner?: readonly { id: string; name: string }[];
  project?: readonly { id: string; displayName: string }[];
  webhook?: readonly { id: string; name: string }[];
}

export type NameIndex = Map<string, string>;

const key = (type: string, id: string) => `${type}:${id}`;

export function buildNameIndex(sources: NameSources): NameIndex {
  const index: NameIndex = new Map();
  for (const user of sources.user ?? []) {
    index.set(key('user', user.id), user.name ?? user.email);
  }
  for (const runner of sources.runner ?? []) {
    index.set(key('runner', runner.id), runner.name);
  }
  for (const project of sources.project ?? []) {
    index.set(key('project', project.id), project.displayName);
  }
  for (const webhook of sources.webhook ?? []) {
    index.set(key('webhook', webhook.id), webhook.name);
  }
  return index;
}

/** The target as a person names it; the id is the fallback's tooltip, not its text. */
export function targetDisplay(
  record: Pick<AuditRecordView, 'targetType' | 'targetId'>,
  index: NameIndex,
): { text: string; title: string | undefined } {
  const { targetType, targetId } = record;
  if (!targetId) return { text: targetType, title: undefined };
  const name = index.get(key(targetType, targetId));
  return name
    ? { text: `${targetType} · ${name}`, title: targetId }
    : { text: targetType, title: targetId };
}

/** A runner actor by name when the runner is known. */
export function runnerActorName(
  record: Pick<AuditRecordView, 'actorRunnerId'>,
  index: NameIndex,
): string {
  const name = record.actorRunnerId
    ? index.get(key('runner', record.actorRunnerId))
    : undefined;
  return name ? `runner ${name}` : 'runner';
}
