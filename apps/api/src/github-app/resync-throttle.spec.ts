import { ResyncThrottle } from './resync-throttle';

describe('ResyncThrottle (C-145)', () => {
  const WINDOW_MS = 60_000;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = () => {
    const runs: number[] = [];
    const start = Date.now();
    const throttle = new ResyncThrottle({
      windowMs: WINDOW_MS,
      run: () => runs.push(Date.now() - start),
    });
    return { runs, throttle };
  };

  it('runs the first request at once', () => {
    const { runs, throttle } = setup();
    throttle.request();
    expect(runs).toEqual([0]);
  });

  it('collapses requests inside the window into one trailing resync at its end', async () => {
    const { runs, throttle } = setup();
    throttle.request();
    for (let i = 0; i < 10; i += 1) {
      await jest.advanceTimersByTimeAsync(1_000);
      throttle.request();
    }
    expect(runs).toEqual([0]);
    await jest.advanceTimersByTimeAsync(WINDOW_MS);
    expect(runs).toEqual([0, WINDOW_MS]);
  });

  it('runs at once again once a window has passed with no request', async () => {
    const { runs, throttle } = setup();
    throttle.request();
    await jest.advanceTimersByTimeAsync(WINDOW_MS + 5_000);
    throttle.request();
    expect(runs).toEqual([0, WINDOW_MS + 5_000]);
  });

  it('clear drops a waiting resync and forgets the window', async () => {
    const { runs, throttle } = setup();
    throttle.request();
    throttle.request();
    throttle.clear();
    await jest.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(runs).toEqual([0]);
    throttle.request();
    expect(runs).toHaveLength(2);
  });
});
