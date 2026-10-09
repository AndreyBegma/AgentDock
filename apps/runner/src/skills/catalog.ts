import {
  SKILL_SEARCH_MAX_ITEMS,
  type SkillCatalogItem,
  type SkillSearchArgs,
  type SkillSearchResult,
  skillCatalogItemSchema,
} from '@agentdock/shared/protocol';
import type { Clock } from '../clock';
import { CommandFailure } from '../commands/failure';
import { errorMessage } from '../log';

/**
 * The catalog origin (D1). Fixed here: no argument, no server config and no
 * runner config can point the runner at another host (spec 24, notes).
 */
export const CATALOG_ORIGIN = 'https://skills.sh';
/** D1: one cached answer per query, for this long. */
export const CATALOG_CACHE_MS = 10 * 60_000;
/** Under the command's own 15 s, so a slow catalog fails here with a message. */
export const CATALOG_FETCH_TIMEOUT_MS = 10_000;
/** A search response larger than this is not a search response. */
export const CATALOG_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_MAX_QUERIES = 200;

export const catalogSearchUrl = (query: string): string =>
  `${CATALOG_ORIGIN}/api/search?q=${encodeURIComponent(query)}`;

/**
 * D1: `{ skills: [{ id, source, skillId, name, installs }] }` → protocol
 * items. An item that does not fit the schema — a source that is not
 * `owner/repo`, a skill id with `..` — is dropped, never repaired.
 */
export const mapSearchResponse = (raw: unknown): SkillCatalogItem[] => {
  const skills = (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) {
    throw new CommandFailure(
      'upstream_unavailable',
      'the catalog answered without a skills list',
    );
  }
  const items: SkillCatalogItem[] = [];
  for (const skill of skills) {
    const s = skill as Record<string, unknown> | null;
    const parsed = skillCatalogItemSchema.safeParse({
      id: s?.id,
      source: s?.source,
      skillId: s?.skillId,
      name: s?.name,
      installs: s?.installs,
    });
    if (parsed.success) items.push(parsed.data);
    if (items.length >= SKILL_SEARCH_MAX_ITEMS) break;
  }
  return items;
};

export interface CatalogDeps {
  fetch: typeof fetch;
  clock: Clock;
}

/** `skill.search` (D1): the catalog, through the runner, cached per query. */
export class SkillCatalog {
  private readonly cache = new Map<
    string,
    { at: number; items: SkillCatalogItem[] }
  >();

  constructor(private readonly deps: CatalogDeps) {}

  async search(args: SkillSearchArgs): Promise<SkillSearchResult> {
    const key = args.query.toLowerCase();
    const now = this.deps.clock.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < CATALOG_CACHE_MS) {
      return { items: cached.items };
    }
    const items = mapSearchResponse(await this.fetchJson(args.query));
    this.cache.delete(key);
    this.cache.set(key, { at: now, items });
    while (this.cache.size > CACHE_MAX_QUERIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return { items };
  }

  private async fetchJson(query: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.deps.fetch(catalogSearchUrl(query), {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CommandFailure(
        'upstream_unavailable',
        `the catalog did not answer: ${errorMessage(error)}`,
      );
    }
    if (!response.ok) {
      throw new CommandFailure(
        'upstream_unavailable',
        `the catalog answered HTTP ${response.status}`,
      );
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > CATALOG_MAX_RESPONSE_BYTES) {
      throw new CommandFailure(
        'upstream_unavailable',
        'the catalog response is too large',
      );
    }
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new CommandFailure(
        'upstream_unavailable',
        'the catalog answered with something that is not JSON',
      );
    }
  }
}
