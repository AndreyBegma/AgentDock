import { connectionShortage, connectionsNeeded } from './connection-budget';

const BASE = 'postgresql://postgres:pw@localhost:5421/agentdock_1_test';

describe('the e2e connection budget (#487)', () => {
  it("counts a pool per Jest worker, from the URL's connection_limit", () => {
    expect(connectionsNeeded(`${BASE}?connection_limit=5`, 2)).toBe(11);
    expect(connectionsNeeded(BASE, 2)).toBe(21);
    expect(connectionsNeeded(`${BASE}?connection_limit=5`, 0)).toBe(6);
  });

  it('lets a run start while the server has room for it', () => {
    expect(
      connectionShortage({ maxConnections: 100, reserved: 3, inUse: 86 }, 11),
    ).toBeNull();
  });

  // The incident: other cards' runs held every slot; the suite timed out for
  // minutes instead of saying so.
  it('names the shortage and the way out when the server is full', () => {
    const message = connectionShortage(
      { maxConnections: 100, reserved: 3, inUse: 97 },
      11,
    );
    expect(message).toContain('needs up to 11 database connections');
    expect(message).toContain('has 0 free');
    expect(message).toContain('--testPathPatterns');
  });
});
