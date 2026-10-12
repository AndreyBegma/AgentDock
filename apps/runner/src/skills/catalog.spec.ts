import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillSearchArgsSchema } from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { FakeClock } from '../testing/fake-clock';
import {
  CATALOG_CACHE_MS,
  CATALOG_ORIGIN,
  catalogSearchUrl,
  mapSearchResponse,
  SkillCatalog,
} from './catalog';

/** `GET https://skills.sh/api/search?q=estimate`, recorded 2026-10-09, trimmed; two hostile items added. */
const RECORDED = readFileSync(
  join(import.meta.dir, 'fixtures', 'search-estimate.json'),
  'utf8',
);

const fakeFetch = (body: string, status = 200) => {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
};

describe('skill.search', () => {
  it('maps a recorded skills.sh response and drops items that do not fit', async () => {
    const { fetchFn, urls } = fakeFetch(RECORDED);
    const catalog = new SkillCatalog({
      fetch: fetchFn,
      clock: new FakeClock(),
    });
    const result = await catalog.search({ query: 'estimate' });
    expect(urls).toEqual(['https://skills.sh/api/search?q=estimate']);
    expect(result.items).toEqual([
      {
        id: 'himself65/finance-skills/estimate-analysis',
        source: 'himself65/finance-skills',
        skillId: 'estimate-analysis',
        name: 'estimate-analysis',
        installs: 2993,
      },
      {
        id: 'donchitos/claude-code-game-studios/estimate',
        source: 'donchitos/claude-code-game-studios',
        skillId: 'estimate',
        name: 'estimate',
        installs: 401,
      },
      {
        id: 'ulpi-io/skills/cost-estimate',
        source: 'ulpi-io/skills',
        skillId: 'cost-estimate',
        name: 'cost-estimate',
        installs: 299,
      },
    ]);
  });

  it('refuses a host or URL argument in the schema', () => {
    for (const args of [
      { query: 'estimate', host: 'evil.example' },
      { query: 'estimate', url: 'https://evil.example/api' },
    ]) {
      expect(skillSearchArgsSchema.safeParse(args).success).toBe(false);
    }
  });

  it('builds the URL on the fixed origin, the query encoded', () => {
    expect(CATALOG_ORIGIN).toBe('https://skills.sh');
    expect(catalogSearchUrl('a&host=evil.example/#x')).toBe(
      'https://skills.sh/api/search?q=a%26host%3Devil.example%2F%23x',
    );
  });

  it('caches per query for ten minutes', async () => {
    const { fetchFn, urls } = fakeFetch(RECORDED);
    const clock = new FakeClock();
    const catalog = new SkillCatalog({ fetch: fetchFn, clock });
    await catalog.search({ query: 'estimate' });
    await catalog.search({ query: 'Estimate' });
    expect(urls).toHaveLength(1);
    clock.advance(CATALOG_CACHE_MS);
    await catalog.search({ query: 'estimate' });
    expect(urls).toHaveLength(2);
  });

  it('answers upstream_unavailable when the catalog fails', async () => {
    for (const { fetchFn } of [
      fakeFetch('oops', 503),
      fakeFetch('not json'),
      fakeFetch('{"nothing":true}'),
    ]) {
      const catalog = new SkillCatalog({
        fetch: fetchFn,
        clock: new FakeClock(),
      });
      const error = await catalog.search({ query: 'x' }).catch((e) => e);
      expect(error).toBeInstanceOf(CommandFailure);
      expect((error as CommandFailure).code).toBe('upstream_unavailable');
    }
    const throwing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const catalog = new SkillCatalog({
      fetch: throwing,
      clock: new FakeClock(),
    });
    const error = await catalog.search({ query: 'x' }).catch((e) => e);
    expect((error as CommandFailure).code).toBe('upstream_unavailable');
  });

  it('keeps a mapped list bounded', () => {
    const skills = Array.from({ length: 500 }, (_, i) => ({
      id: `o/r/s${i}`,
      source: 'o/r',
      skillId: `s${i}`,
      name: `s${i}`,
      installs: i,
    }));
    expect(mapSearchResponse({ skills })).toHaveLength(200);
  });
});
