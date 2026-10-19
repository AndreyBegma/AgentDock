import { retryOnDeadlock } from './e2e-app';

const deadlock = () =>
  Object.assign(new Error('Raw query failed'), {
    code: 'P2010',
    meta: { code: '40P01', message: 'deadlock detected' },
  });

describe('retryOnDeadlock (#673)', () => {
  it('retries a deadlock victim until the statement goes through', async () => {
    let calls = 0;
    const result = await retryOnDeadlock(async () => {
      calls += 1;
      if (calls < 3) throw deadlock();
      return 'reset';
    });
    expect(result).toBe('reset');
    expect(calls).toBe(3);
  });

  it('recognises a bare SQLSTATE as well as the Prisma wrapper', async () => {
    let calls = 0;
    await retryOnDeadlock(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('x'), { code: '40P01' });
    });
    expect(calls).toBe(2);
  });

  it('gives up after the bounded number of attempts', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(async () => {
        calls += 1;
        throw deadlock();
      }, 3),
    ).rejects.toMatchObject({ code: 'P2010' });
    expect(calls).toBe(3);
  });

  it('does not retry any other error', async () => {
    let calls = 0;
    await expect(
      retryOnDeadlock(async () => {
        calls += 1;
        throw new Error('connection refused');
      }),
    ).rejects.toThrow('connection refused');
    expect(calls).toBe(1);
  });
});
