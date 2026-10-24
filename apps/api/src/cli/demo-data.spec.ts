import {
  DEMO_CARDS,
  DEMO_PROJECT_ID,
  DemoDataError,
  demoDatabaseUrl,
  isDemoDatabase,
  maintenanceUrl,
  seedDemo,
} from './demo-data';

const BASE =
  'postgresql://postgres:secret@localhost:5421/agentdock?schema=public';

describe('demo database names', () => {
  it('accepts only agentdock_demo and agentdock_demo_<id>', () => {
    expect(isDemoDatabase('agentdock_demo')).toBe(true);
    expect(isDemoDatabase('agentdock_demo_gulbtfoj')).toBe(true);
    for (const name of [
      'agentdock',
      'agentdock_test',
      'agentdock_demo_',
      'agentdock_demo_Card',
      'agentdock_demo_x"; DROP DATABASE agentdock; --',
      '',
    ]) {
      expect(isDemoDatabase(name)).toBe(false);
    }
  });

  it('swaps only the database of the dev URL', () => {
    expect(demoDatabaseUrl(BASE, 'agentdock_demo_abc123')).toBe(
      'postgresql://postgres:secret@localhost:5421/agentdock_demo_abc123?schema=public',
    );
  });

  it('refuses a name that is not a demo database', () => {
    expect(() => demoDatabaseUrl(BASE, 'agentdock')).toThrow(DemoDataError);
  });

  it('connects to the maintenance database without query options', () => {
    expect(maintenanceUrl(BASE)).toBe(
      'postgresql://postgres:secret@localhost:5421/postgres',
    );
  });
});

describe('seedDemo', () => {
  const prisma = () => ({
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1' }) },
    runner: { upsert: jest.fn() },
    project: { upsert: jest.fn() },
    boardCard: { upsert: jest.fn() },
  });

  it('upserts the runner, the project and every card by a fixed key', async () => {
    const db = prisma();
    const seeded = await seedDemo(db as never, ' Demo@Example.com ');

    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'demo@example.com' },
    });
    expect(seeded).toEqual({
      projectId: DEMO_PROJECT_ID,
      cards: DEMO_CARDS.length,
    });
    expect(db.boardCard.upsert).toHaveBeenCalledTimes(DEMO_CARDS.length);
    for (const call of db.boardCard.upsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
  });

  it('needs the admin to exist', async () => {
    const db = prisma();
    db.user.findUnique.mockResolvedValue(null);
    await expect(seedDemo(db as never, 'demo@example.com')).rejects.toThrow(
      DemoDataError,
    );
  });
});
