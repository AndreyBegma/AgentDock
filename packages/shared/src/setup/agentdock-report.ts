import { z } from 'zod';
import { type ProfileAgentdock, profileAgentdockSchema } from '../protocol';

const profilesAdvertSchema = z.object({
  profiles: z.array(z.unknown()),
});

const profileAdvertSchema = z.object({
  id: z.string().min(1),
  agentdock: profileAgentdockSchema,
});

/**
 * Each profile's D1 report (#281) from stored or received capabilities JSON, by
 * profile key. A profile without a valid `agentdock` is left out: unknown, never
 * "not installed". Read per profile, so one malformed entry — or a stored blob
 * whose other fields no longer validate — does not hide the rest.
 */
export const profileAgentdockOf = (
  capabilities: unknown,
): Record<string, ProfileAgentdock> => {
  const parsed = profilesAdvertSchema.safeParse(capabilities);
  if (!parsed.success) return {};
  const reports = new Map<string, ProfileAgentdock>();
  for (const entry of parsed.data.profiles) {
    const profile = profileAdvertSchema.safeParse(entry);
    if (profile.success && !reports.has(profile.data.id)) {
      reports.set(profile.data.id, profile.data.agentdock);
    }
  }
  return Object.fromEntries(reports);
};
