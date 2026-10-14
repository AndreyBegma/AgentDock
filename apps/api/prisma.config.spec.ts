import config from './prisma.config';

describe('prisma.config', () => {
  it('seeds with ts-node --transpile-only so boot does not type-check the seed graph', () => {
    expect(config.migrations?.seed).toMatch(/^ts-node --transpile-only /);
  });
});
