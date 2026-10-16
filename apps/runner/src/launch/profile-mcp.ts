import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpServerNameSchema } from '@agentdock/shared';
import { PROFILE_MCP_SERVERS_MAX } from '@agentdock/shared/protocol';
import { z } from 'zod';
import type { ConfigProfile } from '../config';
import { expandHome } from '../env';

/**
 * The file Claude Code keeps a profile's user-scope MCP servers in:
 * `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` — beside the
 * config dir, not inside `~/.claude` (checked against Claude Code 2.1.301).
 */
export const profileClaudeJson = (
  profile: ConfigProfile,
  home: string,
): string => {
  const dir = profile.env.CLAUDE_CONFIG_DIR;
  return dir
    ? join(expandHome(dir, home), '.claude.json')
    : join(home, '.claude.json');
};

const claudeJsonSchema = z.object({
  mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/**
 * #445 D6: the MCP servers of the profile's own config, by name, with their
 * definitions as Claude reads them. Unreadable or malformed is none; a name
 * the protocol would refuse is left out.
 */
export const readProfileMcpServers = (
  profile: ConfigProfile,
  home: string,
): Record<string, Record<string, unknown>> => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profileClaudeJson(profile, home), 'utf8'));
  } catch {
    return {};
  }
  const parsed = claudeJsonSchema.safeParse(raw);
  if (!parsed.success) return {};
  return Object.fromEntries(
    Object.entries(parsed.data.mcpServers).filter(
      ([name]) => mcpServerNameSchema.safeParse(name).success,
    ),
  );
};

/**
 * Amendment 2: the names `capabilities` reports for a Claude profile — names
 * only, never a command, env or secret; sorted, at most 64.
 */
export const profileMcpServerNames = (
  profile: ConfigProfile,
  home: string,
): string[] =>
  Object.keys(readProfileMcpServers(profile, home))
    .sort()
    .slice(0, PROFILE_MCP_SERVERS_MAX);
