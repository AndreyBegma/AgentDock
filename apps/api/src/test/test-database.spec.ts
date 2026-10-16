import {
  CARD_CONNECTION_LIMIT,
  CARD_POOL_TIMEOUT_S,
  cardTestDatabaseUrl,
  testDatabaseUrl,
  workerDatabaseUrl,
} from './test-database';

const BASE =
  'postgresql://postgres:pw@localhost:5421/agentdock_test?schema=public';

describe('test databases of a board card (#389)', () => {
  const saved = {
    url: process.env.TEST_DATABASE_URL,
    card: process.env.AGENTDOCK_CARD,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore('TEST_DATABASE_URL', saved.url);
    restore('AGENTDOCK_CARD', saved.card);
  });

  it('keeps the URL as it is outside a card', () => {
    expect(cardTestDatabaseUrl(BASE, undefined)).toBe(BASE);
    expect(cardTestDatabaseUrl(BASE, '')).toBe(BASE);
  });

  it("names a card's database after its short id, on the same server", () => {
    const url = new URL(cardTestDatabaseUrl(BASE, 'h74ymwpx'));
    expect(url.pathname).toBe('/agentdock_card_h74ymwpx_test');
    expect(url.host).toBe('localhost:5421');
    expect(url.searchParams.get('schema')).toBe('public');
  });

  // #487: three cards' e2e runs at once exhausted the dev server's
  // connections — a card's pools are bounded, its workers' databases too.
  it("bounds a card's pool, on its database and every worker's", () => {
    process.env.TEST_DATABASE_URL = BASE;
    process.env.AGENTDOCK_CARD = 'h74ymwpx';
    for (const url of [testDatabaseUrl(), workerDatabaseUrl(1)]) {
      const params = new URL(url).searchParams;
      expect(params.get('connection_limit')).toBe(
        String(CARD_CONNECTION_LIMIT),
      );
      expect(params.get('pool_timeout')).toBe(String(CARD_POOL_TIMEOUT_S));
      expect(params.get('schema')).toBe('public');
    }
  });

  it("keeps a card URL's own pool parameters", () => {
    const url = new URL(
      cardTestDatabaseUrl(
        `${BASE}&connection_limit=2&pool_timeout=3`,
        'h74ymwpx',
      ),
    );
    expect(url.searchParams.get('connection_limit')).toBe('2');
    expect(url.searchParams.get('pool_timeout')).toBe('3');
  });

  it('refuses a card id that is not a short id', () => {
    expect(() => cardTestDatabaseUrl(BASE, 'x"; DROP')).toThrow(
      /AGENTDOCK_CARD/,
    );
  });

  // The incident: two cards' worktrees copied one `.env`; both runs reset
  // `agentdock_test` and cloned `agentdock_1_test`, wiping each other.
  it('two cards that share one TEST_DATABASE_URL never share a database', () => {
    process.env.TEST_DATABASE_URL = BASE;
    const names = (card: string) => {
      process.env.AGENTDOCK_CARD = card;
      return [testDatabaseUrl(), workerDatabaseUrl(1), workerDatabaseUrl(2)];
    };
    const first = names('h74ymwpx');
    const second = names('ab12cd34');
    expect(first.map((u) => new URL(u).pathname)).toEqual([
      '/agentdock_card_h74ymwpx_test',
      '/agentdock_card_h74ymwpx_1_test',
      '/agentdock_card_h74ymwpx_2_test',
    ]);
    for (const url of first) expect(second).not.toContain(url);

    delete process.env.AGENTDOCK_CARD;
    expect(new URL(testDatabaseUrl()).pathname).toBe('/agentdock_test');
  });
});
