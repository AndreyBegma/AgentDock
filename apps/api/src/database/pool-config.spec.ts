import { pgPoolConfig, withoutPoolParams } from './pool-config';

const BASE = 'postgresql://postgres:pw@localhost:5421/agentdock?schema=public';

describe('pgPoolConfig (#487)', () => {
  it("keeps pg's defaults for a URL without pool parameters", () => {
    expect(pgPoolConfig(BASE)).toEqual({
      connectionString: new URL(BASE).toString(),
    });
    expect(pgPoolConfig(undefined)).toEqual({ connectionString: undefined });
  });

  // The pg driver adapter ignores Prisma's `connection_limit`: without this,
  // a card's bounded TEST_DATABASE_URL would still open up to 10 per pool.
  it('bounds the pool and its wait from connection_limit and pool_timeout', () => {
    const config = pgPoolConfig(`${BASE}&connection_limit=5&pool_timeout=10`);
    expect(config.max).toBe(5);
    expect(config.connectionTimeoutMillis).toBe(10_000);
    const url = new URL(config.connectionString ?? '');
    expect(url.searchParams.get('connection_limit')).toBeNull();
    expect(url.searchParams.get('pool_timeout')).toBeNull();
    expect(url.searchParams.get('schema')).toBe('public');
  });

  it('refuses a pool parameter that is not a positive whole number', () => {
    expect(() => pgPoolConfig(`${BASE}&connection_limit=0`)).toThrow(
      /connection_limit/,
    );
    expect(() => pgPoolConfig(`${BASE}&pool_timeout=soon`)).toThrow(
      /pool_timeout/,
    );
  });

  it('withoutPoolParams drops only the pool parameters', () => {
    expect(
      new URL(withoutPoolParams(`${BASE}&connection_limit=5`)).search,
    ).toBe('?schema=public');
  });
});
